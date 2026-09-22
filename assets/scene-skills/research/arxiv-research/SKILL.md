---
name: arxiv-research
description: "arXiv 论文检索与研究综合：API 检索纪律、ar5iv 全文提取、分段精读法、结构化综述产出。Use when the user asks to find/search papers, 查论文, 搜论文, strengthen docs with external research, or write a literature synthesis."
version: 1
license: MIT
---

# arXiv Research

Research pipeline: topic/gap analysis → arXiv API discovery → section extraction → structured synthesis.

Derived from the Hermes Agent `arxiv-research-synths` skill (MIT), generalized: project-specific and finance-quant baggage removed. See Attribution at the end.

## When to use
- User wants to strengthen project docs / designs with external research
- User asks to search arXiv for papers on specific topics
- Evaluating a project's theoretical foundations
- Writing a literature review or research synthesis

## Stage 1 — Gap analysis

1. Read the project docs (README, architecture, plans, research notes)
2. Identify missing theoretical foundations, unvalidated assumptions, missing risk controls
3. Rank gaps by severity (critical / medium / low)
4. Output a gap list: gap description, why it matters, what kind of paper would fix it

## Stage 2 — arXiv search

**Use the arXiv API directly** (not web search — the API is faster and structured):

```bash
# Search by topic: use AND between specific terms
curl -s "https://export.arxiv.org/api/query?search_query=all:retrieval+AND+all:evaluation&start=0&max_results=5&sortBy=submittedDate&sortOrder=descending"

# Lookup by exact ID when you already have a reference
curl -s "https://export.arxiv.org/api/query?search_query=id:2602.19419" | grep -E '<id>http|<title>|<summary>'
```

**Key rules**:
- Use `AND` (not `OR`) between terms for precision — the `OR` operator effectively matches any field and returns noise
- Search by exact arXiv ID when a reference is already known: `id:{ARXIV_ID}`
- Use category filters (`cat:cs.LG`, `cat:cs.CL`, `cat:q-fin.ST`, …) to scope the field
- `sortBy=submittedDate&sortOrder=descending` for the latest papers
- If API search returns noise, switch to `id:` lookups from reference lists
- Run 3–5 API queries in parallel for different gap areas

## Stage 3 — Paper extraction (ar5iv fallback)

PDF text extraction tools often fail; use ar5iv's HTML rendering as fallback:

```bash
curl -sL "https://ar5iv.labs.arxiv.org/html/{ARXIV_ID}" -o /tmp/{slug}.html
```

Then build a section map — scan for section titles with line numbers:

```python
for i, line in enumerate(lines):
    if any(k in line.lower() for k in ['abstract','introduction','method','experiment','result','conclusion']):
        if len(line) < 100:
            print(f"L{i}: {line}")
```

**Must-read sections for each paper**:
- Abstract + Intro → one-sentence contribution
- Method/Model → what to implement or apply
- Experiment/Results → key numbers to cite
- Appendix → hidden implementation details

**Rate limiting**: ar5iv may throttle. Add 1–2s delay between fetches when hitting many papers.

## Stage 4 — Synthesis writing

Write `docs/{project}-research-synthesis.md` with this structure:

```markdown
# Research Gaps & Paper Synthesis

> 评估日期：YYYY-MM-DD

## 一、文档已做到位的
(brief positive assessment)

## 二、核心不足（按影响排序）
### A. Gap title [severity]
- What's missing / Why it matters / Root cause

## 三、论文补强矩阵
### 3.1 Paper Title [relevance]
- arXiv ID + link
- Core contribution (2-3 sentences)
- Direct application to the project (specific modules/features)
- Actionable insights

## 四、发散性跨领域思路
(cross-domain inspirations from the papers)

## 五、论文汇总表
| # | 论文 | arXiv ID | 链接 | 相关度 |

## 六、建议阅读顺序

## 七、建议行动
### 立即可做（1-2 天）
### 本迭代内做
### 远期做
```

## Key learnings (battle-tested)

- **arXiv API `OR` is broken** — returns results from any field. Always `AND`.
- **ar5iv HTML has formula rendering issues** — but section structure is preserved. Good enough for contribution analysis.
- **Read specific line ranges, not full papers** — papers are 20–40 pages. Use the section map to read only what you need.
- **3 papers in parallel is the optimal batch** — more overwhelms context; fewer misses cross-connections.
- **Multi-paper sessions are feasible** with batch discipline: fetch all HTML → extract sections → read key sections → write all syntheses → batch verify. Don't interleave read-write-read across papers.
- **Prioritize directly mappable papers** — papers that map onto existing project modules first, then defensive/safety content, then speculative upgrades.
- **"Failure analysis" papers are high value** — papers describing system failures produce immediately usable safety lessons and need less interpretation than novel-method papers.

## Fallback: no arXiv access

If ar5iv and the arXiv API both fail:
1. Use the abstract page (`arxiv.org/abs/{ID}`) for a contribution summary
2. Search the paper title on Google Scholar → "All versions" → find a free PDF
3. Check SSRN for working-paper versions
4. Ask the user to provide a local PDF path

---

## Attribution

Derived from the Hermes Agent community skill `arxiv-research-synths` (MIT, https://github.com/Undermybelt/hermes-skills), which encodes arXiv API discipline and synthesis methodology from production research runs. Generalized for pi-scenes: project-specific references (finance regime detection, paper2code pipeline) removed; retrieval discipline, extraction workflow, section-reading method, and synthesis structure preserved.
