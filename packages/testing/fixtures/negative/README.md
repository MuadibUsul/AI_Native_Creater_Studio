# SYNTHETIC NEGATIVE TEST DATA — 合成负面测试数据

**警告：本目录下所有内容均为人工合成的负面测试数据，不是真实信息，不可用于任何生产、展示或引用场景。**

用途：验证管线在异常输入下的**校验与降级路径**（对应计划 §11.2 的 AC-15 等场景）。
每个用例文件包含：

- `label`：固定标注 "SYNTHETIC"；
- `purpose`：该用例模拟的失败模式；
- `expectedIssueCodes`：恰好应当触发的审计问题码（测试对此做等值断言，防止误报/漏报）；
- `bundle`：注入缺陷的 fixture bundle。

| 用例 | 模拟的失败模式 | 预期问题码 |
|---|---|---|
| `missing-dataset` | 图表场景引用了不存在的数据集（AC-15：缺数据不得编造） | UNRESOLVED_DATASET |
| `unsourced-fact` | fact 级 Claim 没有来源（§56：AI 不得伪造来源） | MISSING_PROVENANCE |
| `invented-series` | 合成数据被当作事实图表绑定（§10.3） | SYNTHETIC_AS_FACTUAL |
| `dangling-source` | Claim 引用了不存在的来源 | UNRESOLVED_SOURCE |
| `source-hash-mismatch` | 来源快照的 content_hash 与摘录不一致（快照被篡改/损坏） | SOURCE_HASH_MISMATCH |
| `long-text-overflow` | 超长旁白文本（§11.3 中文长标题/缩写不溢出） | OVERFLOW_RISK |

运行：`pnpm test:golden`（同时校验金样与这些负面用例）。
