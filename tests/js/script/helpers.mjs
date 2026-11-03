// Shared test helpers for the momo script compiler.

// An AST without positions, for comparing shapes.
export function strip(node) {
  if (Array.isArray(node)) return node.map(strip);
  if (node && typeof node === "object") {
    const out = {};
    for (const [key, value] of Object.entries(node)) {
      if (["line", "col", "nameLine", "nameCol"].includes(key)) continue;
      out[key] = strip(value);
    }
    return out;
  }
  return node;
}

// momo script text for an AST (fully parenthesised, so it re-parses to the same tree).
export function unparse(node, indent = "") {
  const block = (body) => (body.length ? body.map((s) => unparse(s, indent + "    ")).join("") : `${indent}    pass\n`);
  const e = (n) => unparse(n);
  switch (node.type) {
    case "Program": return (node.header ? `#momo ${node.header.version}\n` : "") + node.body.map((s) => unparse(s)).join("");
    case "Assign": return `${indent}${node.isVar ? "var " : ""}${node.target.id} ${node.op} ${e(node.value)}\n`;
    case "Unpack": return `${indent}${node.targets.map((t) => t.id).join(", ")} = ${e(node.value)}\n`;
    case "ExprStmt": return `${indent}${e(node.expr)}\n`;
    case "If": {
      let out = `${indent}if ${e(node.test)}:\n${block(node.body)}`;
      let rest = node.orelse;
      while (rest.length === 1 && rest[0].type === "If") {
        out += `${indent}elif ${e(rest[0].test)}:\n${block(rest[0].body)}`;
        rest = rest[0].orelse;
      }
      if (rest.length) out += `${indent}else:\n${block(rest)}`;
      return out;
    }
    case "For": return `${indent}for ${node.target.id} in ${e(node.iter)}:\n${block(node.body)}`;
    case "While": return `${indent}while ${e(node.test)}:\n${block(node.body)}`;
    case "Def": {
      const params = node.params.map((p) => (p.default ? `${p.name}=${e(p.default)}` : p.name)).join(", ");
      return `${indent}def ${node.name}(${params}):\n${block(node.body)}`;
    }
    case "Return": return `${indent}return${node.value ? " " + e(node.value) : ""}\n`;
    case "Break": return `${indent}break\n`;
    case "Continue": return `${indent}continue\n`;
    case "Pass": return `${indent}pass\n`;
    case "Num": return String(node.value);
    case "Str": return JSON.stringify(node.value);
    case "FStr": return `f"${node.parts.map((p) => (typeof p === "string" ? p.replace(/[{}"\\]/g, (c) => (c === "{" || c === "}" ? c + c : "\\" + c)) : `{${e(p.expr)}${p.spec ? ":" + p.spec : ""}}`)).join("")}"`;
    case "Bool": return node.value ? "true" : "false";
    case "Na": return "na";
    case "Name": return node.id;
    case "List": return `[${node.items.map(e).join(", ")}]`;
    case "Tuple": return `(${node.items.map(e).join(", ")})`;
    case "Unary": return node.op === "not" ? `(not ${e(node.operand)})` : `(-${e(node.operand)})`;
    case "Binary": return `(${e(node.left)} ${node.op} ${e(node.right)})`;
    case "Cond": return `(${e(node.then)} if ${e(node.test)} else ${e(node.else)})`;
    case "Index": return `${e(node.target)}[${e(node.index)}]`;
    case "Attr": return `${e(node.target)}.${node.name}`;
    case "Call": return `${e(node.callee)}(${[...node.args.map(e), ...node.kwargs.map((k) => `${k.name}=${e(k.value)}`)].join(", ")})`;
    default: throw new Error(`unparse: ${node.type}`);
  }
}
