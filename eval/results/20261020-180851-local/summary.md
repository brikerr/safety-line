## Eval results

Run 2026-10-20 18:14 PDT against `http://localhost:3000`, gold file `eval/gold_draft.jsonl`, 50 questions (single 36, multi 4, refuse 10).
Page tolerance: exact. Keyword pass threshold: 0.5. Judge model: `claude-sonnet-5-5`.

| Slice | n | errors | Refusal acc. | Cit. precision | Cit. recall | Doc recall | Retrieval hit | Keyword cov. | Keyword pass | Judge score |
|---|---|---|---|---|---|---|---|---|---|---|
| Overall | 50 | 0 | 90% | 30% | 61% | 95% | 66% | 69% | 82% | 77% |
| single | 36 | 0 | 89% | 32% | 65% | 97% | 71% | 72% | 83% | 76% |
| multi | 4 | 0 | 75% | 11% | 25% | 75% | 25% | 41% | 25% | 38% |
| refuse | 10 | 0 | 100% | n/a | n/a | n/a | n/a | n/a | 100% | 94% |

How to read it: refusal accuracy covers every item (answered when it should answer, declined when it should decline). Citation precision, citation recall, doc recall, retrieval hit and keyword coverage are averaged over single and multi items only; refuse items show n/a. A range citation such as pp. 19-20 matches a gold page inside it. Retrieval hit is whether a retrieved passage covers the gold page, whether or not the answer cited it. Keyword pass on refuse items means the item was declined.

<details><summary>Per question</summary>

| id | type | refused | refusal ok | P | R | retrieval | kw cov. | kw pass | judge | citations |
|---|---|---|---|---|---|---|---|---|---|---|
| q01 | single | no | yes | 100% | 100% | 100% | 95% | yes | 1 | [NIST AI RMF, pp. 19-20] |
| q02 | single | no | yes | 33% | 100% | 100% | 78% | yes | 1 | [NIST AI RMF, pp. 12-13]; [NIST AI RMF, p. 12]; [NIST AI RMF, pp. 19-20] |
| q03 | single | no | yes | 33% | 100% | 100% | 100% | yes | 1 | [NIST AI RMF, pp. 45-46]; [NIST AI RMF, pp. 6-7]; [NIST AI RMF, pp. 19-20] |
| q04 | single | no | yes | 33% | 100% | 100% | 100% | yes | 1 | [NIST AI RMF, pp. 37-38]; [NIST AI RMF, pp. 19-20]; [NIST AI RMF, pp. 25-26] |
| q05 | single | no | yes | 20% | 100% | 100% | 66% | yes | 1 | [NIST GenAI Profile, p. 13]; [NIST GenAI Profile, pp. 7-8]; [NIST GenAI Profile, pp. 38-40]; [NIST GenAI Profile, pp. 34-36]; [NIST GenAI Profile, pp. 5-6] |
| q06 | single | yes | **no** | 0% | 0% | 0% | 62% | no | 0 | [NIST GenAI Profile, pp. 26-27]; [NIST GenAI Profile, pp. 17-18]; [NIST GenAI Profile, pp. 34-36]; [NIST GenAI Profile, pp. 5-6] |
| q07 | single | yes | **no** | 0% | 0% | 0% | 21% | no | 0 | [NIST GenAI Profile, pp. 51-52] |
| q08 | single | no | yes | 50% | 100% | 100% | 86% | yes | 1 | [NIST GenAI Profile, pp. 51-52]; [NIST GenAI Profile, p. 13] |
| q09 | single | no | yes | 0% | 0% | 100% | 58% | yes | 1 | [Intl AI Safety Report, pp. 91-92]; [Intl AI Safety Report, pp. 147-148]; [Intl AI Safety Report, p. 94] |
| q10 | single | no | yes | 17% | 100% | 100% | 86% | yes | 1 | [Intl AI Safety Report, pp. 75-76]; [Intl AI Safety Report, pp. 76-77]; [Intl AI Safety Report, pp. 77-78]; [Intl AI Safety Report, p. 12]; [Intl AI Safety Report, pp. 80-81]; [Intl AI Safety Report, pp. 82-83] |
| q11 | single | no | yes | 33% | 100% | 100% | 77% | yes | 1 | [Intl AI Safety Report, pp. 70-72]; [Intl AI Safety Report, pp. 73-74]; [Intl AI Safety Report, p. 12] |
| q12 | single | no | yes | 0% | 0% | 100% | 61% | yes | 1 | [Intl AI Safety Report, p. 149]; [Intl AI Safety Report, p. 112]; [Intl AI Safety Report, pp. 130-131] |
| q13 | single | yes | **no** | 0% | 0% | 0% | 13% | no | 0 | [Intl AI Safety Report, pp. 14-15]; [Intl AI Safety Report, p. 40] |
| q14 | single | no | yes | 0% | 0% | 0% | 56% | yes | 0.5 | [NHTSA Distraction Guidelines, p. 64]; [NHTSA Distraction Guidelines, pp. 63-64]; [NHTSA Distraction Guidelines, p. 30]; [NHTSA Distraction Guidelines, p. 3] |
| q15 | single | no | yes | 100% | 100% | 100% | 100% | yes | 1 | [NHTSA Distraction Guidelines, p. 69] |
| q16 | single | no | yes | 67% | 100% | 100% | 93% | yes | 1 | [NHTSA Distraction Guidelines, p. 71]; [NHTSA Distraction Guidelines, p. 72]; [NHTSA Distraction Guidelines, pp. 71-72] |
| q17 | single | no | yes | 0% | 0% | 0% | 72% | yes | 0.5 | [NHTSA Distraction Guidelines, p. 3]; [NHTSA Distraction Guidelines, pp. 32-33] |
| q18 | single | no | yes | 25% | 100% | 100% | 82% | yes | 1 | [NHTSA Distraction Guidelines, p. 66]; [NHTSA Distraction Guidelines, pp. 14-15]; [NHTSA Distraction Guidelines, p. 31]; [NHTSA Distraction Guidelines, p. 3] |
| q19 | single | no | yes | 20% | 100% | 100% | 82% | yes | 1 | [NHTSA L2/L3 Guidance, pp. 32-34]; [NHTSA L2/L3 Guidance, p. 34]; [NHTSA L2/L3 Guidance, p. 25]; [NHTSA L2/L3 Guidance, pp. 33-34]; [NHTSA L2/L3 Guidance, pp. 24-25] |
| q20 | single | no | yes | 0% | 0% | 0% | 46% | no | 0 | [NHTSA L2/L3 Guidance, pp. 9-10]; [NHTSA L2/L3 Guidance, pp. 38-39]; [NHTSA L2/L3 Guidance, p. 25]; [NHTSA L2/L3 Guidance, pp. 33-34]; [NHTSA L2/L3 Guidance, p. 34] |
| q21 | single | yes | **no** | 0% | 0% | 0% | 18% | no | 0 | [NHTSA L2/L3 Guidance, pp. 38-39]; [NHTSA L2/L3 Guidance, pp. 9-10]; [NHTSA L2/L3 Guidance, p. 39] |
| q22 | single | no | yes | 0% | 0% | 0% | 62% | yes | 0.5 | [NHTSA L2/L3 Guidance, p. 9]; [NHTSA L2/L3 Guidance, pp. 9-10]; [NHTSA L2/L3 Guidance, pp. 38-39] |
| q23 | single | no | yes | 50% | 100% | 100% | 61% | yes | 0.5 | [FDA AI Device Draft, pp. 11-12]; [FDA AI Device Draft, p. 15] |
| q24 | single | no | yes | 25% | 100% | 100% | 69% | yes | 1 | [FDA AI Device Draft, p. 13]; [FDA AI Device Draft, p. 15]; [FDA Human Factors, pp. 14-15]; [FDA AI Device Draft, pp. 14-15] |
| q25 | single | no | yes | 33% | 100% | 100% | 85% | yes | 1 | [FDA AI Device Draft, pp. 19-20]; [FDA AI Device Draft, pp. 20-21]; [FDA AI Device Draft, p. 5] |
| q26 | single | no | yes | 100% | 100% | 100% | 76% | yes | 1 | [FDA AI Device Draft, pp. 19-20]; [FDA AI Device Draft, pp. 20-21] |
| q27 | single | no | yes | 33% | 50% | 50% | 48% | no | 0.5 | [FDA AI Device Draft, p. 31]; [FDA AI Device Draft, pp. 29-30]; [FDA AI Device Draft, p. 52] |
| q28 | single | no | yes | 0% | 0% | 0% | 67% | yes | 1 | [FDA Human Factors, p. 16]; [FDA Human Factors, p. 18]; [FDA Human Factors, pp. 27-28]; [FDA AI Device Draft, p. 51]; [FDA Human Factors, p. 5] |
| q29 | single | no | yes | 20% | 100% | 100% | 86% | yes | 1 | [FDA Human Factors, p. 16]; [FDA Human Factors, p. 6]; [FDA Human Factors, p. 18]; [FDA Human Factors, p. 20]; [FDA AI Device Draft, p. 51] |
| q30 | single | no | yes | 25% | 100% | 100% | 89% | yes | 1 | [FDA Human Factors, pp. 23-24]; [FDA Human Factors, pp. 14-15]; [FDA Human Factors, pp. 27-28]; [FDA Human Factors, p. 5] |
| q31 | single | no | yes | 100% | 100% | 100% | 88% | yes | 1 | [FDA Human Factors, pp. 38-39]; [FDA Human Factors, pp. 39-40] |
| q32 | single | no | yes | 50% | 100% | 100% | 90% | yes | 1 | [OSHA Robot Safety, sec. VIII]; [OSHA Robot Safety, sec. VI] |
| q33 | single | no | yes | 33% | 100% | 100% | 62% | yes | 1 | [OSHA Robot Safety, sec. VI]; [OSHA Robot Safety, app. 1]; [OSHA Robot Safety, sec. II] |
| q34 | single | no | yes | 50% | 100% | 100% | 96% | yes | 1 | [OSHA Robot Safety, sec. VI]; [OSHA Robot Safety, sec. VIII] |
| q35 | single | no | yes | 100% | 100% | 100% | 100% | yes | 1 | [OSHA Robot Safety, sec. VI] |
| q36 | multi | yes | **no** | 0% | 0% | 0% | 13% | no | 0 | [NHTSA L2/L3 Guidance, p. 20]; [NHTSA L2/L3 Guidance, pp. 17-18]; [FDA Human Factors, p. 45] |
| q37 | single | no | yes | 0% | 0% | 0% | 53% | yes | 0 | [NHTSA Distraction Guidelines, p. 2]; [NHTSA Distraction Guidelines, p. 10]; [NHTSA Distraction Guidelines, pp. 3-4] |
| q38 | multi | no | yes | 20% | 50% | 50% | 64% | yes | 0.5 | [NIST AI RMF, pp. 19-20]; [NIST AI RMF, pp. 45-46]; [Intl AI Safety Report, pp. 120-121]; [Intl AI Safety Report, pp. 138-139]; [Intl AI Safety Report, pp. 82-83] |
| q39 | multi | no | yes | 25% | 50% | 50% | 42% | no | 0.5 | [NHTSA L2/L3 Guidance, pp. 15-16]; [NHTSA L2/L3 Guidance, pp. 38-39]; [NHTSA L2/L3 Guidance, p. 12]; [NHTSA L2/L3 Guidance, pp. 14-15] |
| q40 | multi | no | yes | 0% | 0% | 0% | 43% | no | 0.5 | [OSHA Robot Safety, sec. VI] |
| q41 | refuse | yes | yes | n/a | n/a | n/a | n/a | yes | 1 | none |
| q42 | refuse | yes | yes | n/a | n/a | n/a | n/a | yes | 1 | none |
| q43 | refuse | yes | yes | n/a | n/a | n/a | n/a | yes | 1 | [OSHA Robot Safety, sec. IX] |
| q44 | refuse | yes | yes | n/a | n/a | n/a | n/a | yes | 1 | [Intl AI Safety Report, p. 118]; [Intl AI Safety Report, p. 128] |
| q45 | refuse | yes | yes | n/a | n/a | n/a | n/a | yes | 1 | [NHTSA L2/L3 Guidance, pp. 10-11]; [NHTSA L2/L3 Guidance, p. 39] |
| q46 | refuse | yes | yes | n/a | n/a | n/a | n/a | yes | 1 | [FDA Human Factors, pp. 38-39]; [FDA Human Factors, pp. 39-40]; [NHTSA L2/L3 Guidance, p. 44] |
| q47 | refuse | yes | yes | n/a | n/a | n/a | n/a | yes | n/a | [OSHA Robot Safety, sec. VIII]; [OSHA Robot Safety, sec. IX] |
| q48 | refuse | yes | yes | n/a | n/a | n/a | n/a | yes | 1 | [FDA AI Device Draft, pp. 5-6]; [FDA Human Factors, p. 5]; [FDA Human Factors, p. 6] |
| q49 | refuse | yes | yes | n/a | n/a | n/a | n/a | yes | 1 | [OSHA Robot Safety, sec. VI] |
| q50 | refuse | yes | yes | n/a | n/a | n/a | n/a | yes | 0.5 | [NIST AI RMF, pp. 6-7]; [NIST AI RMF, pp. 43-44]; [NIST AI RMF, pp. 18-19]; [NIST AI RMF, pp. 19-20] |

</details>
