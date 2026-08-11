import { parse } from "@babel/parser";
import ts from "typescript";
import type { LLMProvider } from "@/lib/providers";
import type { Device, RetrievedComponent } from "@/lib/types";
import { generatePlainSystemPrompt } from "@/lib/prompts";
import { prototypeNavigationRepairInstruction, unsafePrototypeNavigation } from "@/lib/prototypeNavigation";

const MAX_REPAIR_ROUNDS = 2;

// 修复要重新输出整份代码，必须给足额度，否则大文件会被截断、越修越坏（v4-pro 推理还会额外吃 token）
const REPAIR_MAX_TOKENS = 128000;


/**
 * 确保代码有 React 默认导入。沙箱用经典 JSX 转换（编译成 React.createElement），
 * 缺少 `import React` 会运行时报 "React is not defined"（Sonnet 常只 import 具名 hooks）。
 */
export function ensureReactImport(code: string): string {
  // 已有 React（默认或命名空间导入）
  if (/import[^;\n]*\bReact\b[^;\n]*from\s*['"]react['"]/.test(code)) return code;
  // 有具名 react 导入 → 补上默认 React
  const named = code.match(/import\s*\{([^}]*)\}\s*from\s*['"]react['"]\s*;?/);
  if (named) return code.replace(named[0], `import React, {${named[1]}} from 'react';`);
  // 完全没有 react 导入 → 顶部补一行
  return `import React from 'react';\n${code}`;
}

/** 校验 JSX，返回错误信息 + 行号（用于精准修复） */
function jsxError(code: string): { message: string; line?: number } | null {
  try {
    parse(code, { sourceType: "module", plugins: ["jsx"] });
    return null;
  } catch (e) {
    const err = e as { message?: string; loc?: { line?: number } };
    return { message: err?.message ?? String(e), line: err?.loc?.line };
  }
}

/** 校验生成代码是否为合法 JSX；合法返回 null，否则返回错误信息 */
export function checkJsx(code: string): string | null {
  return jsxError(code)?.message ?? null;
}

/** 取出错行附近的代码片段（带行号），帮助模型精准定位 */
function codeExcerpt(code: string, line?: number, ctx = 4): string {
  if (!line) return "";
  const lines = code.split("\n");
  const from = Math.max(0, line - 1 - ctx);
  const to = Math.min(lines.length, line + ctx);
  return lines
    .slice(from, to)
    .map((l, i) => `${from + i + 1}| ${l}`)
    .join("\n");
}

/**
 * 模型容易把示例 TSX 片段抄进生成代码里，例如
 * interface、type、: React.FC、参数类型标注等。这里先做确定性降级：
 * 保留 JSX、移除类型，再交给 Babel 校验。
 */
export function normalizeGeneratedCode(code: string): string {
  const trimmed = code.trim();
  if (!checkJsx(trimmed)) return trimmed;

  const transpiled = ts.transpileModule(trimmed, {
    fileName: "GeneratedPrototype.tsx",
    compilerOptions: {
      jsx: ts.JsxEmit.Preserve,
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
      skipLibCheck: true,
    },
  }).outputText.trim();

  return !checkJsx(transpiled) ? transpiled : trimmed;
}

function syntaxFallbackPage(error: string): string {
  const safe = JSON.stringify(error);
  return `import React from 'react';

export default function App() {
  return (
    <div style={{ padding: 24, fontFamily: 'sans-serif', color: '#1f2328' }}>
      <h2>原型代码需要重新生成</h2>
      <p>生成结果仍包含 Playground 不支持的语法，已拦截避免预览页直接编译崩溃。</p>
      <pre style={{ whiteSpace: 'pre-wrap', padding: 16, background: '#fff5f5', border: '1px solid #ffd6d6', borderRadius: 6 }}>
        {${safe}}
      </pre>
    </div>
  );
}`;
}

/** 扫描从某个包具名导入的标识符（兼容多行 import；按右引号精确匹配，'antd-mobile' 不会误匹配 'antd-mobile-icons'） */
function importedNamesFrom(code: string, pkg: string): string[] {
  const re = new RegExp(`import\\s*\\{([^}]*)\\}\\s*from\\s*['"]${pkg}['"]`, "g");
  const names: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(code))) {
    for (const raw of m[1].split(",")) {
      const name = raw.trim().split(/\s+as\s+/)[0].trim();
      if (name) names.push(name);
    }
  }
  return names;
}

/**
 * 找出"会渲染失败"的违规导入（防幻觉）。
 * - 本次只生成原生 HTML：任何组件库导入都算违规。
 */
export function invalidImports(code: string, useDpl = true, device: Device = "pc"): string[] {
  return [
    ...new Set([
      ...importedNamesFrom(code, "antd-mobile"),
      ...importedNamesFrom(code, "antd-mobile-icons"),
    ]),
  ];
}

/**
 * 校验 + 自修复：检测「语法错误」和「目录外组件导入」，把问题回灌给模型修一次。
 * 返回最终代码 + 修复前后状态（供编排层 emit 进度）。
 */
export async function repairIfNeeded(
  provider: LLMProvider,
  components: RetrievedComponent[],
  code: string,
  useDpl = true,
  device: Device = "pc"
): Promise<{ code: string; hadIssue: boolean; fixed: boolean; detail: string; blockedNavigation?: string[] }> {
  const normalizedCode = normalizeGeneratedCode(code);
  const syntax = checkJsx(normalizedCode);
  const badImports = invalidImports(normalizedCode, useDpl, device);
  const badNavigation = unsafePrototypeNavigation(normalizedCode);
  if (!syntax && badImports.length === 0 && badNavigation.length === 0) {
    return {
      code: normalizedCode,
      hadIssue: normalizedCode !== code,
      fixed: normalizedCode !== code,
      detail: normalizedCode !== code ? "已转换 TSX 为 JSX，语法与组件校验通过" : "语法与组件校验通过",
    };
  }

  const system = generatePlainSystemPrompt(device);
  const fixInstruction = `禁止 import 任何组件库（如 antd / antd-mobile 等），改用原生 HTML 元素 + 内联样式实现。`;

  let current = normalizedCode;

  for (let round = 0; round < MAX_REPAIR_ROUNDS; round++) {
    const err = jsxError(current);
    const bad = invalidImports(current, useDpl, device);
    const badNavigation = unsafePrototypeNavigation(current);
    if (!err && bad.length === 0 && badNavigation.length === 0) break; // 已干净

    const importProblem = bad.length
      ? `本次不使用任何组件库，但导入了：${bad.join("、")}（请改用原生 HTML 实现）`
      : "";
    const syntaxProblem = err
      ? `JSX 语法错误：${err.message}\n出错位置附近的代码：\n${codeExcerpt(current, err.line)}`
      : "";
    const navigationProblem = badNavigation.length ? prototypeNavigationRepairInstruction(badNavigation) : "";
    const problems = [syntaxProblem, importProblem, navigationProblem].filter(Boolean).join("\n\n");

    let raw: string;
    try {
      raw = await provider.complete({
        system,
        messages: [
          {
            role: "user",
            content: `下面的代码有问题需要修正：\n${problems}\n\n要求：${fixInstruction}保持其余逻辑不变，**输出完整的、修正后的全部代码**（不要省略、不要解释、不要 Markdown 代码块包裹）：\n\n${current}`,
          },
        ],
        maxTokens: REPAIR_MAX_TOKENS,
      });
    } catch {
      // 网络等失败：跳出，用当前代码做最终判定
      break;
    }
    current = normalizeGeneratedCode(
      raw
        .replace(/^\s*```[a-zA-Z]*\s*/, "")
        .replace(/\s*```\s*$/, "")
        .trim()
    );
  }

  const finalSyntax = jsxError(current)?.message ?? null;
  if (finalSyntax) {
    // 多轮仍未修好（多为生成本身严重残缺）→ 兜底占位页，避免预览崩溃
    return {
      code: syntaxFallbackPage(finalSyntax),
      hadIssue: true,
      fixed: false,
      detail: "多轮自修复仍有语法错误，返回错误占位页（建议重新生成）",
    };
  }
  const finalBad = invalidImports(current, useDpl, device);
  const finalNavigation = unsafePrototypeNavigation(current);
  if (finalNavigation.length) {
    // 生成代码会在 srcDoc 中直接执行；二次修复仍保留真实导航时宁可给可读兜底页，
    // 不能把宿主应用路由带进预览 iframe。原型编辑路径会把此结果识别为异常并保留上一版。
    return {
      code: syntaxFallbackPage(`检测到不允许的页面导航：${finalNavigation.join("、")}。请重新生成或改为页内交互。`),
      hadIssue: true,
      fixed: false,
      detail: `已拦截不安全页面导航：${finalNavigation.join("、")}`,
      blockedNavigation: finalNavigation,
    };
  }
  const clean = finalBad.length === 0 && finalNavigation.length === 0;
  return {
    code: current,
    hadIssue: true,
    fixed: clean,
    detail: clean
      ? "已修复（语法/组件/页面导航）"
      : `部分修复，仍有问题：${[...finalBad, ...finalNavigation].join("、")}`,
  };
}

interface ThemeToken {
  hex: string;
  rgb: [number, number, number];
  saturated: boolean;
}

/** 解析 themeCss :root{} 里的 `--name:#RRGGBB` 对，提取品牌色 token。 */
function parseThemeTokens(themeCss?: string): ThemeToken[] {
  if (!themeCss) return [];
  const tokens: ThemeToken[] = [];
  const re = /--[a-z0-9-]+\s*:\s*(#[0-9a-fA-F]{6})\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(themeCss))) {
    const hex = m[1].toUpperCase();
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    // 仅「有显著色相」的品牌色（如橘/蓝/紫）才参与就近矫正；中性灰（#333/#fff/#ECECED 等）
    // 用途泛、容差易误伤，要求精确匹配，不做近似吸附。
    const saturated = Math.max(r, g, b) - Math.min(r, g, b) > 30;
    tokens.push({ hex, rgb: [r, g, b], saturated });
  }
  return tokens;
}

/** 就近吸附阈值（RGB 曼哈顿距离）：覆盖单通道 0x20 级别漂移（如 #FF8060→#FF8040，差 32）。 */
const COLOR_SNAP_THRESHOLD = 48;

/**
 * 确定性矫正品牌色漂移：把生成代码里「接近但不等」于品牌 token 的十六进制色值
 * 原地改写成精确 token 值。仅吸附饱和品牌色，中性灰要求精确匹配。
 * 返回矫正后的代码 + 命中列表（供日志/进度展示）。
 */
export function normalizeBrandColors(
  code: string,
  themeCss?: string
): { code: string; fixed: string[] } {
  const tokens = parseThemeTokens(themeCss).filter((t) => t.saturated);
  if (!tokens.length) return { code, fixed: [] };

  const fixed: string[] = [];
  const seen = new Set<string>();
  const result = code.replace(/#[0-9a-fA-F]{6}\b/g, (orig) => {
    const hex = orig.toUpperCase();
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);

    let best: { hex: string; dist: number } | null = null;
    for (const t of tokens) {
      const dist = Math.abs(t.rgb[0] - r) + Math.abs(t.rgb[1] - g) + Math.abs(t.rgb[2] - b);
      if (dist === 0) return orig; // 已是精确品牌色，原样保留
      if (!best || dist < best.dist) best = { hex: t.hex, dist };
    }
    if (best && best.dist <= COLOR_SNAP_THRESHOLD) {
      const label = `${orig}→${best.hex}`;
      if (!seen.has(label)) {
        seen.add(label);
        fixed.push(label);
      }
      return best.hex;
    }
    return orig;
  });
  return { code: result, fixed };
}
