// lib/security/secret-redactor.js — 摄入侧密钥脱敏(纯函数,0 依赖,不碰 IO)
//
// 【为什么单开一条,而不是复用 security.js 的 redactSensitiveText】
// 那边的规则表 API_KEY_PATTERNS 是"一套真值两个消费者":既做替换,也做
// before_tool_call 的 **拦截** 判定(containsApiKey → block)。把 `token=` 这种
// 宽泛形态塞进去,会让正常 Bash 调用被误杀,代价是把用户的工具链打瘸。
// 实测(node -e 直接调 redactSensitiveText)它对本仓 4 种真实形态 **全部 MISS**:
//   `?token=<48位hex>` / `Authorization: Bearer <v>` / `X-Hook-Token: <v>` / `TOKEN="<v>"`
// 所以摄入侧需要一条更宽、但只替换不拦截的独立规则,两者互不污染。
//
// 【证据:2026-08 对 "use guide"/(152 文件)+ wiki/(64 文件)的全量只读扫描】
// 命中 17 处明文凭据(去重后 2 个不同的密钥值),形态分布:
//   8× `?token=<48 位小写 hex 网关 token>`(URL query)
//   4× `Authorization: Bearer <hook token>`
//   2× `X-Hook-Token: <hook token>`
//   1× `TOKEN="<hook token>"`(shell 变量)
//   wiki/ 0 处 —— 泄漏全部来自 memos KB(kind:"user" 的 global KB,任何 agent 都能检索到)
// **17 处全部带上下文锚点,没有一处是"裸露的高熵串"。**
//
// 【取舍:只在有锚点时脱敏,绝不扫裸串】
// 备忘录正文里到处是 sha256 chunk hash、commit sha、长标识符,一条"32+ 位 hex 就脱敏"
// 的裸串规则会把正文打烂(实测裸 hex 规则在本仓另有大量命中,全是内容而非密钥)。
// 上面的分布证明:锚点规则在真实语料上漏检为 0,而裸串规则的误伤是确定的。
// 误伤 RAG 正文的代价 > 漏掉一个假想中的裸密钥 —— 所以宁可漏,不误伤。
//
// 【取舍:token 家族要求 value 含数字】
// 实测误报语料:`use guide/[过时]备忘录_多Agent实施计划_2026-03-08.md:427` 的
// `token = CancellationToken()` —— 17 位纯字母标识符,长度过关但明显是代码。
// 加"至少含一个数字"后该误报消失,而两个真实密钥(48 位 hex、含 `2026`)照旧命中。
// password 家族不加这条(口令天然可能没数字,且 `password=` 的误报面远小于 `token=`)。
//
// 【取舍:只替换 value,保留 key 和上下文】
// `?token=***REDACTED***` 比整行删掉更有用:chunk 仍能回答"怎么调 debug 接口",
// 只是不再泄漏凭据本身。

export const SECRET_PLACEHOLDER = "***REDACTED***";

// 凭据 value 的字符集:刻意不含引号/空格/尖括号/括号 —— `<hooks.token>` 这类占位符
// 天然被排除(实测语料 备忘录13:164 就是这种写法,不该被动)。
const VALUE = "[A-Za-z0-9._\\-]{16,}";

// 每条规则的正则都恰好两个捕获组:(1)=保留的前缀 (2)=要替换掉的 value。
// 前缀为空的规则用 `()` 占位,保证替换逻辑只有一条路径。
const RULES = [
  // 厂商前缀:自带锚点,零误伤;不要求含数字(AKIA/xox 可能全字母)。
  {
    re: /()\b((?:sk|nvapi|dsk)-[A-Za-z0-9_-]{20,}|gh[pou]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|AIza[A-Za-z0-9_-]{30,})/g,
    requireDigit: false,
  },
  // JWT:三段式点分,形态本身就是锚点。
  {
    re: /()\b(eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,})/g,
    requireDigit: false,
  },
  // `Bearer <v>`:锚点极强,正文里几乎不可能出现,所以不要求含数字。
  {
    re: new RegExp(`(\\bBearer\\s+)(${VALUE})`, "gi"),
    requireDigit: false,
  },
  // 口令家族:`password=` / `passwd:` / `pwd="`。不要求含数字(见上方取舍)。
  {
    re: new RegExp(`(\\b(?:password|passwd|pwd)\\b["'\`]?\\s*[:=]\\s*["'\`]?)(${VALUE})`, "gi"),
    requireDigit: false,
  },
  // token/key 家族:覆盖 URL query(`?token=`)、HTTP header(`X-Hook-Token:`,
  // `-Token` 前的连字符提供 \b)、JSON(`"token": "…"`)、shell(`TOKEN="…"`)。
  // key 名后面那个可选引号是 JSON 形态必需的 —— 漏了它 `{"token": "…"}` 不会命中
  // (本条由测试 `脱敏 shell 变量赋值与 JSON 字段` 抓出来过)。
  // 前置 \b 保证 `mytoken=` 这种不被误吃。
  {
    re: new RegExp(
      `(\\b(?:token|api[-_]?key|apikey|secret|access[-_]?key|auth[-_]?token|authorization)\\b["'\`]?\\s*[:=]\\s*["'\`]?)(${VALUE})`,
      "gi",
    ),
    requireDigit: true,
  },
];

function isRedactable(value, trailing, requireDigit) {
  if (requireDigit && !/\d/.test(value)) return false; // 纯字母 → 多半是标识符,见头部取舍
  if (/REDACTED/i.test(value)) return false; // 幂等:已脱敏的不再动
  return !trailing.startsWith("("); // `CancellationToken()` 这类调用表达式
}

// 把文本里"带凭据锚点"的密钥值替换成占位符。保守优先:宁可漏检,不误伤正文。
// 幂等 —— 占位符含 `*`,不在 value 字符集里,重复调用不会二次替换。
//
// extraSecrets:调用方已知的**字面量**密钥(如从 openclaw.json 读到的
// gateway.auth.token / hooks.token)。锚点规则天生管不了"裸值",全语料实测残留 1 处:
// `use guide/[过时]备忘录13_…_V9并发派发研究:166` 写的是 `- 当前值: \`<hook token>\``
// —— 只有中文标签,没有任何英文凭据 key。给这种加中文锚点规则误伤面太大("当前值"
// 可以是任何配置),而字面量精确匹配零误伤,是这类残留唯一安全的补法。
// 长度 < 12 的条目直接忽略:配置里若有短值,全文替换会把正文打烂。
export function redactSecrets(text, { extraSecrets = [] } = {}) {
  let out = String(text ?? "");
  for (const secret of extraSecrets) {
    const literal = String(secret ?? "");
    if (literal.length < 12) continue;
    out = out.split(literal).join(SECRET_PLACEHOLDER); // split/join = 字面量替换,免正则转义
  }
  for (const { re, requireDigit } of RULES) {
    out = out.replace(re, (match, prefix, value, offset, whole) => {
      const trailing = whole.slice(offset + match.length);
      return isRedactable(value, trailing, requireDigit) ? `${prefix}${SECRET_PLACEHOLDER}` : match;
    });
  }
  return out;
}
