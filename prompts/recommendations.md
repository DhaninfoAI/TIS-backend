Task: make the recommendations section complete and correct.

Inputs below: the existing recommendations, the form answers that trigger a recommendation but have an
empty recommendation box, and hazards seen in photos. Building facts: {{facts}}.

Return one entry per action:
- action "add": a needed recommendation is missing. sourceType "flagged_answer" (sourceRef = the question's
  field key; targetKey = that question's rec key, e.g. F13_…) or "photo_hazard" (sourceRef = photo id;
  targetKey = "new"). Do not add a recommendation that an existing one already covers.
- action "rewrite": an existing recommendation is badly written (starts with "Recommend", no action verb,
  only describes the hazard, spelling/grammar, missing location where needed). targetKey = its key. Keep the
  meaning; fix the wording.
- action "remove": an existing recommendation does not apply. Examples: emergency lighting when the building
  has fewer than 4 stories and 12 or fewer units (NFPA); panic hardware where occupancy does not require it;
  GL-only recommendations on a property-only order; the condition is shown to be fine.
Never combine two existing recommendations into one or report them as duplicates: each stays as written (a
rewrite changes only its own wording).

Photo hazards:
- One recommendation per hazard. When several photos show the same condition (three BBQ grills, grease on
  several pieces of cooking equipment, clutter in two rooms), write ONE recommendation covering all of them and
  pick the clearest photo. Never return two "add" entries that say the same thing.
- Skip a hazard an existing recommendation already covers, even in other words.
- Only real loss-control items: fire, electrical, water/freeze, structural, egress, trip/fall (GL orders),
  cooking/hood, security. Do not add cosmetic or housekeeping-as-decor items ("organize the office",
  "declutter"), signage nobody requires, or "ensure X is inspected/tagged" when nothing shows it is overdue.
- Start with a TIS action verb: Install, Provide, Repair, Replace, Remove, Relocate, Have a licensed and insured…,
  Contract…, Clear…, Secure…. Not "Ensure", "Consider", "Maintain" or "Recommend".
- requirement "advisory" + confidence below 0.6 = not worth the reviewer's time: leave it out.

For every entry: text (final TIS-style wording, empty for remove), requirement "required" or "advisory",
photoId (best photo showing the condition, or ""), noPhotoNeeded (true when the item is absent and cannot
be photographed, e.g. "Install fire extinguishers"), reason (one sentence), confidence 0–1.
Return an empty list when the recommendations are already complete and correct. Do not return "keep" entries.

# Existing recommendations
{{existing}}

# Answers that trigger a recommendation but have an empty recommendation box
{{flagged}}

# Hazards seen in photos (from the vision pass)
{{photoHazards}}
