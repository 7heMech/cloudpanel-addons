export interface NginxDirective {
  words: string[];
  start: number;
  end: number;
}
export interface NginxBlock {
  words: string[];
  open: number;
  directives: NginxDirective[];
  end: number;
  children: NginxBlock[];
}

export function nginxServers(content: string): NginxBlock[] {
  const tokens = /\s+|#[^\n]*|\{\{[^}]*\}\}|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|(?:\$\{[^}]+\}|\\.|[^\s{};#"'\\])+|[{};]/gy;
  const stack: NginxBlock[] = [];
  const result: NginxBlock[] = [];
  let words: string[] = [];
  let start = 0;
  while (tokens.lastIndex < content.length) {
    const token = tokens.exec(content);
    if (!token) throw new Error("could not parse Nginx vhost");
    const value = token[0];
    if (/^\s|^#/.test(value)) continue;
    if (value.startsWith("{{") && words.length === 0) {
      if (value === "{{server_name}}") stack.at(-1)?.directives.push({ words: ["server_name", value], start: token.index, end: tokens.lastIndex });
      continue;
    }
    if (value === "{") {
      const block: NginxBlock = { words, open: token.index + 1, end: content.length, directives: [], children: [] };
      stack.at(-1)?.children.push(block);
      stack.push(block);
      words = [];
    } else if (value === "}") {
      const block = stack.pop();
      if (!block) throw new Error("unbalanced Nginx vhost");
      block.end = tokens.lastIndex;
      if (stack.length === 0 && block.words.join(" ") === "server") result.push(block);
      words = [];
    } else if (value === ";") {
      stack.at(-1)?.directives.push({ words, start, end: tokens.lastIndex });
      words = [];
    } else {
      if (words.length === 0) start = token.index;
      words.push(value.replace(/^(["'])(.*)\1$/s, "$2"));
    }
  }
  if (stack.length || words.length) throw new Error("incomplete Nginx vhost");
  return result;
}

