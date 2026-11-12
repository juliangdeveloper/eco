export function normalize(text) {
  return String(text || "").normalize("NFD").replace(/\p{M}+/gu, "").toLocaleLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim();
}

export function phonetic(word) {
  return word.replace(/h/g, "").replace(/k|q/g, "c").replace(/z/g, "s").replace(/v/g, "b").replace(/y/g, "i").replace(/(.)\1+/g, "$1");
}

export function distance(a, b) {
  const row = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i++) {
    let previous = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const current = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, previous + (a[i - 1] === b[j - 1] ? 0 : 1));
      previous = current;
    }
  }
  return row[b.length];
}

export function isTruncation(a, b) {
  if (!a || !b || a === b) return false;
  return a.startsWith(b) || a.endsWith(b) || b.startsWith(a) || b.endsWith(a);
}
