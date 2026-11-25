# 雨课堂 AI 陪练助手 · 自动答题

针对雨课堂「AI 陪练助手」页面（`*/ai-workspace/ai-training-partner/*`）的油猴脚本：自动取题、作答、记录结果。

**不需要大模型，不需要 API Key** —— 靠选项穷举就能做到 100% 正确。

## 功能

- 自动循环取题、提交、翻下一题
- 支持单选 / 多选 / 判断（填空、主观题自动跳过）
- 悬浮面板：题数、提交间隔、实时进度、逐题日志
- 每题显示走了哪条路（服务端给答案 / 穷举）和提交次数

## 安装

1. 浏览器安装 [Tampermonkey](https://www.tampermonkey.net/)（或 Violentmonkey）
2. 点击安装：**[trainer.user.js](https://raw.githubusercontent.com/beeeeeeef/ykt-ai-trainer/main/trainer.user.js)**
3. 打开雨课堂 AI 陪练页，按 `F5` 刷新

> 面板没出现？点 Tampermonkey 图标，如果显示「篡改猴没有访问此页面的权限」，点那一行授权；或到 `edge://extensions` → 篡改猴「详细信息」→「网站访问权限」改成「在所有网站上」。

## 使用

右下角面板设好「题数」和「间隔ms」，点「开始」。

```
第 1 题 [单选] 关于"路由"与"转发"的关系…
  ✓ B（穷举，2 次提交）
第 2 题 [判断] 统计复用必然意味着端到端时延恒定…
  ✓ B（服务端给答案，2 次提交）
结束：共 2 题，答对 2，累计提交 4 次。
```

脚本走接口、不点页面元素，所以**页面本身不会跟着变** —— 答完按 `F5` 才能看到最新进度。

## 工作原理

题目和判题都在接口里，脚本直接调：

1. `POST /mooc-api/v1/lms/exercise/training_partner/problem/` 取题
2. `POST /mooc-api/v1/lms/exercise/training_partner/answer/` 提交，返回 `is_correct`
3. 答错时服务端**不给**答案（`is_show_answer:false`）；答对时连 `answer` 和 `explain` 一起返回

所以策略是：先把第一个选项连 `need_explain_and_answer: true` 发一次（若服务端肯提前交答案，2 次收工），拿不到就按选项穷举 —— 单选最多 4 次、判断 2 次、多选按子集。命中即停，那一次响应里就带着正确答案和解析。

细节见 [NOTES.md](NOTES.md)。

## 已知限制

| 限制 | 说明 |
|---|---|
| 填空 / 主观题 | 无法穷举，直接跳过 |
| 提交次数 | 依赖服务端不限制重复提交。若某课程配了 `max_retry`，穷举会失败 |
| 页面不同步 | 走接口不改 Vue 状态，需手动刷新 |
| 仅限 AI 陪练页 | `@match` 只匹配这一个路径，其它页面不注入 |

## 风险声明

- 这是**自测练习**页面，不是考试。自动作答会让你自己的正确率统计失去意义，而那本来是这个功能的全部意义。
- 每次提交都会在服务端留下记录（`submit_count`、`kg_problem_result_id`），「同一题多次提交」的模式是可识别的。
- 平台改版随时可能让脚本失效，尤其是重复提交限制一旦加上，穷举策略立刻归零。

## 许可证

[MIT](LICENSE)
