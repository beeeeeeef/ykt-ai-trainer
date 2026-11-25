# 接口笔记：雨课堂 AI 陪练页

记录这些接口是怎么被找到的、以及实测到的真实行为。不含任何个人或课程标识。

## 怎么找到的

1. 页面 HTML 里拿到入口 bundle：`https://fe-static-yuketang.yuketang.cn/fe/static/web/<ver>/js/aiworkspace.<hash>.js`
2. 在 bundle 里搜路由片段 `training-partner`，拿到 route 定义：
   ```js
   {path:"/ai-training-partner/:classroom_id/:graph_id/",
    component: function(){ return Promise.all([n.e(1545),...,n.e(65738)]).then(n.bind(n,98172)) }}
   ```
   `n.e(...)` 的参数是该页面独有的懒加载 chunk id。
3. 从 `manifest.<hash>.js` 的 `i.u` 函数里抽出 chunk id → hash 映射，只下 route 尾部那几个 chunk。
4. chunk 里有接口常量表：

```js
ai_coach: {
  get_recommend_knowledge_list: "/c27/online_courseware/ykt/agent/relate_knowledge_nodes/",
  get_training_partner_info:     "/mooc-api/v1/lms/kg/kg_classroom_agent/",
  get_training_history:          "/mooc-api/v1/lms/exercise/training_partner/history/",
  get_exercise_item:             "/mooc-api/v1/lms/exercise/training_partner/problem/",
  get_weakness_exercise_item:    "/mooc-api/v1/lms/exercise/weakness/problem/",
  generate_similar_question:     "/mooc-api/v1/lms/exercise/similar_problem/problem/",
  submit_training_exercise:      "/mooc-api/v1/lms/exercise/training_partner/answer/",
  training_ai_correction:        "/mooc-api/v1/lms/exercise/training_partner/ai_correction/",
  get_pre_knowledge_for_ai:      "/mooc-api/v1/lms/exercise/training_partner/pre_node_check/"
}
```

5. 参数和响应字段来自调用点代码，不是猜的。

## 接口表

| 用途 | 方法 + 路径 | 参数 |
|---|---|---|
| 陪练信息（取 `agent_id`） | `GET /mooc-api/v1/lms/kg/kg_classroom_agent/` | `classroom_id`, `node_id` |
| 取题 | `POST .../training_partner/problem/` | `agent_id`, `classroom_id`, `kg_id`, `node_id_list[]`，可选 `exclude_problem_id` / `exclude_ai_problem_id` |
| 提交 | `POST .../training_partner/answer/` | `problem_id`, `problem_type`, `classroom_id`, `answer[]`，可选 `need_explain_and_answer` |
| 换一题 | `POST /mooc-api/v1/lms/exercise/similar_problem/problem/` | `agent_id`, `problem_id`, `problem_type`, `node_id` |
| 历史正确率 | `POST .../training_partner/history/` | `classroom_id`, `kg_id`, `node_id_list` |
| AI 点评 | `POST .../training_partner/ai_correction/` | — |
| 前置知识检查 | `GET .../training_partner/pre_node_check/` | `agent_id`, `kg_id`, `node_id`, `classroom_id` |

**URL → 参数**：`/ai-training-partner/{classroom_id}/{graph_id}?node_id=A&node_id=B`
→ `classroom_id` = 第一段，`kg_id` = 第二段（= graph_id），`node_id_list` = 重复的 `node_id`。

## 实测请求 / 响应

### 取题

```json
// 请求
{"agent_id": 10973, "classroom_id": "25011001", "kg_id": "42526",
 "node_id_list": [2231369, 2231377, 2231469]}

// 响应 data.problem[0]
{"problem_id": 6186220, "problem_type": 1, "submit_count": 0, "correct": false,
 "node_id": 2231369, "difficulty": 5,
 "content": {"Body": "题干……", "max_retry": 1, "score": 1.0,
             "Type": "SingleChoice", "ProblemType": 1,
             "Options": [{"key": "A", "value": "选项一"}, {"key": "B", "value": "选项二"}]}}

// 另有 data.history_data: {history_count, correct_count, correct_rate}
```

题库抽空时返回 `problem: []`，不是报错。带 `exclude_problem_id: [已见过的 problem_id]` 才能拿到新题。

### 提交

```json
// 请求：answer 是选项 key 的数组
{"problem_id": 6186220, "problem_type": 1, "classroom_id": "25011001", "answer": ["A"]}

// 答错：不吐答案
{"count": -1, "is_show_answer": false, "is_right": false, "is_correct": false,
 "my_answer": ["A"], "submit_count": 1, "is_show_explain": false,
 "kg_problem_result_id": 11563432}

// 答对：answer + explain 一起返回
{"count": -1, "is_show_answer": true, "is_right": true, "is_correct": true,
 "my_answer": ["B"], "submit_count": 2, "answer": ["B"],
 "explain": "选 B。……", "is_show_explain": true}
```

## 由此确定的结论

1. **服务端不会主动交答案。** 答错时 `is_show_answer:false`，响应里既没有 `answer` 也没有 `explain`。
2. **前端从不发 `need_explain_and_answer`。** 触发条件是 `-1 != max_retry`，而 agent 配置里五种题型 `max_retry` 全是 `-1`（不限），条件恒假。手动带这个字段能否强制服务端交答案，尚未验证 —— 脚本做成「先试一次，不行退穷举」。
3. **穷举可行。** `submit_count` 递增但无硬上限（同题连续提交均 200）。
4. **题型编码**来自 `kg_classroom_agent` 返回的 `question_type_setting_map`：1 单选 / 2 多选 / 4 填空 / 5 主观 / 6 判断。
5. **统计按每题最终结果算。** 同题先答错再答对，正确率仍是 100%，穷举不会把数据刷坏。
6. **请求要带的头和参数**：`XTBZ: ykt`、`X-CSRFToken`（取 `csrftoken` cookie 同值）、`credentials: include`；URL 补 `uv_id`（学校 id）和 `platform_id=3`。

## 其它

- 这一页题目是纯文本，**没有字体反混淆问题**（作业/试卷页才有）。
- 雨课堂是多区域多前端站点：`/v2/web`、`/pro/lms`、`/ai-workspace/lms-graph`、`/ai-workspace/ai-training-partner` 是四套互不通用的前端，脚本按 path 前缀分派，不要按域名。
