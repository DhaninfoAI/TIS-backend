Task: check the inspection narrative against TIS's narrative question set and the ordered coverages, then
write a draft narrative in TIS's house style. The narrative is never a source of truth: the form answers,
recommendations, comments and photo results win. The reviewer decides whether to use the draft.

Coverage on this order: {{coverage}}

Narrative instructions embedded in the form:
"""
{{instructions}}
"""

Current narrative:
"""
{{narrative}}
"""

## 1. answers: TIS's building narrative question set
For every question below return { id, answer, inForm, inNarrative, fieldKey }:
- answer: the fact from the report in a few words ("3 stories", "roof replaced 2018, good condition"), or "" if
  the report does not say.
- inForm: true if a form answer, comment, recommendation or photo result gives it (fieldKey = that field's key,
  e.g. "F1_112414_1_10703856", or ""). The ids q1–q34 are TIS's own list and have nothing to do with the form's
  question numbers: q16 is about apartment units, not the form's question "16.". Pick the field whose question asks
  the same thing.
- inNarrative: true if the current narrative states it (correctly or not).
Questions marked (GL) apply because the order includes General Liability. A hazardous-tenant block is listed
only when such a tenant seems present; return hazardousTenants = the tenant types you confirm from the report.
{{questions}}

## 2. coverage: ordered coverages that must be addressed in writing (GLOBAL-001)
For each coverage below return { coverage, addressed (yes | partial | no), where, topics }: does the current
narrative (or another written area) address it? topics = what is missing, from the list given. Never invent facts.
{{coverageNeeds}}

## 3. issues: problems in the current narrative
Errors in what the narrative says, not what it leaves out: missing content is recorded only through section 1
(the question set), the same list the draft covers, so never report "the narrative does not mention X" here.
Each with type (contradiction | stale_value | spelling | grammar | style), topic (2–4 words
naming what it is about, e.g. "square footage", "roof age", "sprinkler coverage", "restaurant operations"; one
issue per topic), quote (the exact words from the narrative, or "" for missing content), formValue (the exact form answer / recommendation text that
conflicts, or ""), problem (one sentence), fix (what it should say), fieldKey (the form field that is the truth, or
""), meaningDiffers (true only when the narrative and the form say different things), confidence 0–1.
List only real problems; never list a statement to note that it agrees with the form.
- contradiction: the narrative states X and a form answer or recommendation explicitly states not-X
  (e.g. narrative "housekeeping is good" vs answer "Housekeeping satisfactory? No"). Fill both quote and
  formValue. NOT contradictions: something left out (section 1 records that), wording that agrees in
  substance ("100% vacant" = "0% occupied"), a condition that a recommendation addresses.
- stale_value: an old number or statement left behind (e.g. a square footage that no longer matches).

## 4. draft: a complete narrative in TIS's style
Write the narrative TIS would want for this risk, using the examples below as the model for tone, order and
wording (third person, past/present tense as in the examples, plain sentences, one to three paragraphs,
300–600 words). Typical order: "The risk is a [stories]-story, [construction] (ISO-[class]) building…",
tenants and occupancy, year built and ownership, total area, losses, walls/roof/interior finishes, utilities
(electric, plumbing, heating/cooling, updates), hazardous operations (e.g. cooking: hood, AES, K-class
extinguisher), {{glNote}} fire protection (sprinklers, extinguishers, alarm and monitoring, fire department,
hydrant), security, surroundings, housekeeping and maintenance, overall condition.
Rules for the draft:
- Cover every question of section 1 that this report answers, in the order above and in the examples' wording.
  Leave out questions the report does not answer or that do not apply here: never write that something is "not
  applicable", "N/A" or absent only to tick a question off (no tenants on a vacant building, no stairs so no
  handrails). The coverage question (q1) decides whether the liability topics belong in the draft; do not write
  the coverage or policy type as a sentence (TIS's narratives never do).
- Use only facts in this report (form answers, comments, recommendations, photo results). Where the current
  narrative and the form disagree, the form wins. Keep facts from the current narrative that nothing in the
  report contradicts (fire department, hydrant distance, monitoring company…).
- Never invent names, dates, distances, companies or numbers. If a core fact (construction, stories, area,
  year built, occupancy, sprinklers) is missing, write [[confirm: what is needed]] in its place; leave out
  other unknown topics rather than guessing. At most 5 [[confirm: …]] markers.
- Address every coverage listed in section 2 (e.g. summarise workplace safety findings for Workers' Comp).
- No headings, bullet points or field keys in the draft.

TIS example narratives (style only; their facts belong to other risks):
{{examples}}
