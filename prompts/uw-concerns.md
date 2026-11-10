Task: check that every underwriter concern on this order is answered in the report.

The underwriter's instructions (order form "Additional Instructions / Special Coverages") are:
"""
{{instructions}}
"""

1. Split the instructions into individual concerns (one per question or request). Plain instructions to the
   inspector ("Inspect main building") are concerns too.
2. For each, decide addressed = yes / partial / no. Look in the Special Underwriter Concerns Response box,
   the narrative, relevant form answers, attached forms (e.g. "Include Freeze Supplement" is satisfied when
   that supplement is attached and filled), and photos.
3. where: the field key or a short quote that answers it ("" if nowhere).
4. contradiction: if photos or answers contradict the response, explain briefly; else "".
5. answer: a short factual answer drafted only from report facts, or "[[confirm: …]]" when the report has no
   facts to answer it.

Finally write draftResponse: the full text for the Underwriter Concerns Response box as a numbered list in
the same order as the concerns, e.g. "1) Walking surfaces were in acceptable condition. 2) …".

answer and draftResponse go to the underwriter: plain sentences only. Never write field keys (F1_…, F4_…),
photo numbers, image ids or square brackets in them, and don't say where in the report a fact was found ("as
confirmed by the narrative and form…"). Field keys and photo ids belong only in "where".
