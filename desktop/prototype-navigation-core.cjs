const NAVIGATION_RULES = [
  {
    label: "location 赋值",
    pattern: /(?:\b(?:window|document|top|parent)\.location(?:\.href)?|(?<![.\w$])location(?:\.href)?)\s*=\s*(?:["'][^"']*["']|[^;\n]+)/gi,
  },
  {
    label: "location 跳转 API",
    pattern: /\b(?:window|document|top|parent)?\.?location\.(?:assign|replace|reload)\s*\([^)]*\)/gi,
  },
  { label: "window.open", pattern: /\bwindow\.open\s*\([^)]*\)/gi },
  {
    label: "非锚点链接",
    pattern: /\bhref\s*=\s*(?:["']\s*(?![#]|javascript:)[^"']+["']|\{)/gi,
  },
  { label: "表单提交地址", pattern: /\b(?:action|formAction)\s*=/gi },
  { label: "跨框架 target", pattern: /\btarget\s*=\s*["']_(?:top|parent)["']/gi },
  { label: "meta 刷新", pattern: /<meta\b[^>]*\bhttp-equiv\s*=\s*["']?refresh\b/gi },
  { label: "base URL", pattern: /<base\b[^>]*\bhref\s*=/gi },
];

function prototypeNavigationFindings(code) {
  const source = String(code || "");
  const findings = [];
  for (const rule of NAVIGATION_RULES) {
    rule.pattern.lastIndex = 0;
    for (const match of source.matchAll(rule.pattern)) {
      findings.push({ label: rule.label, index: match.index || 0, match: String(match[0] || "").slice(0, 160) });
    }
  }
  return findings.sort((a, b) => a.index - b.index || a.label.localeCompare(b.label));
}

function unsafePrototypeNavigation(code) {
  return [...new Set(prototypeNavigationFindings(code).map((finding) => finding.label))];
}

function introducedPrototypeNavigation(before, after) {
  const countBySignature = (source) => {
    const counts = new Map();
    for (const finding of prototypeNavigationFindings(source)) {
      const signature = `${finding.label}\u0000${finding.match.replace(/\s+/g, " ").trim()}`;
      counts.set(signature, (counts.get(signature) || 0) + 1);
    }
    return counts;
  };
  const beforeCounts = countBySignature(before);
  const afterCounts = countBySignature(after);
  const introduced = [];
  for (const [signature, count] of afterCounts) {
    const delta = count - (beforeCounts.get(signature) || 0);
    const label = signature.split("\u0000", 1)[0];
    for (let index = 0; index < delta; index += 1) introduced.push(label);
  }
  return introduced;
}

module.exports = {
  introducedPrototypeNavigation,
  prototypeNavigationFindings,
  unsafePrototypeNavigation,
};
