"""Who is asking: accounts come from Tailscale identity, allowed by `data/access.toml`.

`tailscale serve` replaces any client-sent `Tailscale-User-*` headers with the caller's real
identity and always adds `Tailscale-Headers-Info` and `X-Forwarded-For`. So a request carrying
either marker came through Tailscale and must name an allowed login. A request without them
can only come from this machine (the server listens on loopback) and acts as the owner, which
keeps local tools working. Tagged devices reach serve without a login and are refused.

    # data/access.toml
    [accounts.owner]              # the owner's id is always "owner"
    login = "you@example.com"
    name = "Alex"

    [accounts.sam]                # any other id: a member who can view and practise
    login = "sam@example.com"
    name = "Sam"
    live = true                   # optional: sees live prices (the owner always does)
"""

from __future__ import annotations

import tomllib
from dataclasses import dataclass
from pathlib import Path

from starlette.requests import HTTPConnection

from momo_scan.storage import OWNER

LOOPBACK_HOSTS = {"127.0.0.1", "localhost", "[::1]"}


@dataclass(frozen=True)
class Account:
    id: str
    name: str
    login: str = ""
    live: bool = False

    @property
    def owner(self) -> bool:
        return self.id == OWNER

    @property
    def sees_live(self) -> bool:
        """Live prices are licensed to the owner; members only when allowed in access.toml."""
        return self.owner or self.live


LOCAL_OWNER = Account(id=OWNER, name="Owner")


class AccessDenied(Exception):
    pass


def load_accounts(path: Path) -> dict[str, Account]:
    """Allowed accounts by Tailscale login. A missing file allows no one over Tailscale."""
    if not path.exists():
        return {}
    with path.open("rb") as handle:
        data = tomllib.load(handle)
    accounts: dict[str, Account] = {}
    for account_id, entry in data.get("accounts", {}).items():
        login = str(entry.get("login", "")).strip().lower()
        if not login:
            raise ValueError(f"Account {account_id} in {path} has no login")
        name = str(entry.get("name", account_id))
        live = entry.get("live", False) is True
        accounts[login] = Account(id=account_id, name=name, login=login, live=live)
    return accounts


def identify(request: HTTPConnection, accounts: dict[str, Account]) -> Account:
    headers = request.headers
    via_tailscale = "tailscale-headers-info" in headers or "x-forwarded-for" in headers
    if not via_tailscale:
        host = headers.get("host", "").rsplit(":", 1)[0]
        if host in LOOPBACK_HOSTS or host == "testserver":
            return LOCAL_OWNER
        raise AccessDenied("Unrecognised host")
    login = headers.get("tailscale-user-login", "").strip().lower()
    account = accounts.get(login)
    if account is None:
        raise AccessDenied(f"{login or 'This device'} doesn't have access to momo")
    return account
