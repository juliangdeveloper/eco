const INLINE_PATTERN = /(\[([^\]]*)\]\(([^\s)]+)\)|`([^`]+)`|\*\*([^*]+)\*\*|\*([^*]+)\*|_([^_]+)_|https:\/\/[^\s<]+)/g;
const HEADING_PATTERN = /^(#{1,6})\s+(.+)$/;
const UNORDERED_LIST_PATTERN = /^(\s*)[-*+]\s+(.+)$/;
const ORDERED_LIST_PATTERN = /^(\s*)(\d+)[.)]\s+(.+)$/;

function safeUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : "";
  } catch {
    return "";
  }
}

function appendLink(parent, label, url) {
  const href = safeUrl(url);
  if (!href) {
    parent.append(document.createTextNode(label));
    return;
  }
  const link = document.createElement("a");
  link.href = href;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  appendInline(link, label);
  parent.append(link);
}

function appendInline(parent, text) {
  let lastIndex = 0;
  INLINE_PATTERN.lastIndex = 0;
  for (const match of text.matchAll(INLINE_PATTERN)) {
    parent.append(document.createTextNode(text.slice(lastIndex, match.index)));
    if (match[2] !== undefined) {
      appendLink(parent, match[2], match[3]);
    } else if (match[4] !== undefined) {
      const code = document.createElement("code");
      code.textContent = match[4];
      parent.append(code);
    } else if (match[5] !== undefined) {
      const strong = document.createElement("strong");
      appendInline(strong, match[5]);
      parent.append(strong);
    } else if (match[6] !== undefined || match[7] !== undefined) {
      const emphasis = document.createElement("em");
      appendInline(emphasis, match[6] ?? match[7]);
      parent.append(emphasis);
    } else {
      appendLink(parent, match[0], match[0]);
    }
    lastIndex = match.index + match[0].length;
  }
  parent.append(document.createTextNode(text.slice(lastIndex)));
}

function listMatch(line) {
  const unordered = line.match(UNORDERED_LIST_PATTERN);
  if (unordered) {
    return { indent: unordered[1].length, ordered: false, text: unordered[2] };
  }
  const ordered = line.match(ORDERED_LIST_PATTERN);
  if (ordered) {
    return { indent: ordered[1].length, ordered: true, number: Number(ordered[2]), text: ordered[3] };
  }
  return null;
}

function appendList(parent, lines, start) {
  const first = listMatch(lines[start]);
  const list = document.createElement(first.ordered ? "ol" : "ul");
  if (first.ordered && first.number > 1) {
    list.start = first.number;
  }
  let index = start;

  while (index < lines.length) {
    const item = listMatch(lines[index]);
    if (!item || item.indent !== first.indent || item.ordered !== first.ordered) {
      break;
    }
    const listItem = document.createElement("li");
    appendInline(listItem, item.text);
    index += 1;
    while (index < lines.length) {
      const nested = listMatch(lines[index]);
      if (!nested || nested.indent <= first.indent) {
        break;
      }
      index = appendList(listItem, lines, index);
    }
    list.append(listItem);
  }

  parent.append(list);
  return index;
}

export function renderMarkdown(parent, text) {
  const lines = String(text ?? "").replace(/\r\n?/g, "\n").split("\n");
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) {
      index += 1;
      continue;
    }
    if (line.trimStart().startsWith("```")) {
      const codeLines = [];
      index += 1;
      while (index < lines.length && !lines[index].trimStart().startsWith("```")) {
        codeLines.push(lines[index]);
        index += 1;
      }
      if (index < lines.length) {
        index += 1;
      }
      const pre = document.createElement("pre");
      const code = document.createElement("code");
      code.textContent = codeLines.join("\n");
      pre.append(code);
      parent.append(pre);
      continue;
    }
    const heading = line.match(HEADING_PATTERN);
    if (heading) {
      const tag = "h" + Math.min(6, heading[1].length + 2);
      const title = document.createElement(tag);
      appendInline(title, heading[2]);
      parent.append(title);
      index += 1;
      continue;
    }
    if (listMatch(line)) {
      index = appendList(parent, lines, index);
      continue;
    }
    const paragraphLines = [line];
    index += 1;
    while (index < lines.length && lines[index].trim() && !lines[index].trimStart().startsWith("```") && !lines[index].match(HEADING_PATTERN) && !listMatch(lines[index])) {
      paragraphLines.push(lines[index]);
      index += 1;
    }
    const paragraph = document.createElement("p");
    appendInline(paragraph, paragraphLines.join(" "));
    parent.append(paragraph);
  }
}
