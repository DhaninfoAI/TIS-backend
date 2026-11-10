// Fake OpenAI /v1/chat/completions for offline tests of the AI modules (no key, no cost).
// Returns schema-valid answers built from keys/ids found in the prompt, so the mapping code
// (prompt → JSON → findings → proposed writes) is exercised end to end.
import http from 'node:http';

const pick = (re, s) => [...s.matchAll(re)].map(m => m[1]);

function answer(schema, text) {
  switch (schema) {
    case 'photo_review': {
      const ids = pick(/id (\d+), current caption/g, text);
      return { photos: ids.map((id, i) => ({ imageId: id, description: `Photo ${id}: building area.`, scene: i === 0 ? 'basement' : 'exterior',
        suggestedCaption: i === 0 ? 'Basement – accumulated storage' : 'Front', captionOk: i !== 0,
        source: i === 1 ? 'street_view' : 'on_site', sourceEvidence: i === 1 ? 'Google watermark' : '', sourceConfidence: 0.9,
        hazards: i === 0 ? [{ hazardType: 'housekeeping', severity: 'required', evidence: 'Boxes and debris stacked near utilities', confidence: 0.86, recommendation: 'Improve housekeeping, removing accumulated storage from the basement.' }] : [] })) };
    }
    case 'photo_source_check':   // the focused single-photo check confirms the batch's Street View guess
      return { source: 'street_view', signs: [{ kind: 'text', detail: '© 2012 Google' }], confidence: 0.9 };
    case 'uw_concerns':
      return { draftResponse: '1) Water damage in common areas has been repaired. 2) [[confirm: roof condition]]',
        concerns: [{ concern: 'Check common areas for water damage', addressed: 'yes', where: 'Special Underwriter Concerns Response', answer: 'Repaired.', contradiction: '' },
                   { concern: 'Ensure all water damage has been repaired', addressed: 'partial', where: '', answer: '[[confirm]]', contradiction: '' }] };
    case 'recommendations': {
      const flagged = [...text.matchAll(/- \[(F\d+_[\d_]+)\][^\n]*rec box: (F13_[\d_]+)/g)][0];
      const existing = pick(/- \[(F1[34]_[\d_]+)\]/g, text)[0];
      const photo = pick(/photo (\d+) \|/g, text)[0] || '';
      const out = [];
      if (flagged) out.push({ action: 'add', targetKey: flagged[2], mergeKeys: [], sourceType: 'flagged_answer', sourceRef: flagged[1], text: 'Provide for the condition noted to be corrected.', requirement: 'required', photoId: photo, noPhotoNeeded: false, reason: 'Answer triggers a recommendation.', confidence: 0.9 });
      if (photo) out.push({ action: 'add', targetKey: 'new', mergeKeys: [], sourceType: 'photo_hazard', sourceRef: photo, text: 'Improve housekeeping, removing accumulated storage from the basement.', requirement: 'required', photoId: photo, noPhotoNeeded: false, reason: 'Visible clutter.', confidence: 0.85 });
      if (existing) out.push({ action: 'rewrite', targetKey: existing, mergeKeys: [], sourceType: 'existing', sourceRef: existing, text: 'Repair or replace the damaged item, as necessary.', requirement: 'required', photoId: '', noPhotoNeeded: false, reason: 'Clearer wording.', confidence: 0.7 });
      // the 22-order run: the model listed the kept rec among the duplicates (would write it, then clear it)
      const second = pick(/- \[(F1[34]_[\d_]+)\]/g, text)[1];
      if (second) out.push({ action: 'merge', targetKey: second, mergeKeys: [second], sourceType: 'existing', sourceRef: second, text: 'Provide and maintain the item noted, as necessary.', requirement: 'required', photoId: '', noPhotoNeeded: false, reason: 'Same hazard.', confidence: 0.7 });
      // and the same photo hazard twice in other words
      if (photo) out.push({ action: 'add', targetKey: 'new', mergeKeys: [], sourceType: 'photo_hazard', sourceRef: photo, text: 'Improve housekeeping by removing the accumulated storage in the basement.', requirement: 'required', photoId: photo, noPhotoNeeded: false, reason: 'Visible clutter.', confidence: 0.8 });
      return { recommendations: out };
    }
    case 'rec_photos': {
      const rec = pick(/- \[(F1[34]_[\d_]+)\][^\n]*current photo: NONE/g, text)[0];
      const photo = pick(/\n- (\d{6,}) \|/g, text)[0];
      return { matches: rec && photo ? [{ recKey: rec, imageId: photo, noPhotoNeeded: false, alternatives: [], reason: 'Caption matches.', confidence: 0.8 }] : [] };
    }
    case 'questions': {
      const q = [...text.matchAll(/- \[(F2_[\d_]+)\] ([^|\n]*)\| Yes \/ No[^|\n]*\| Yes/g)][0];
      const h = [...text.matchAll(/- \[(F2_[\d_]+)\] (\d+\. Housekeeping[^|\n]*)\| Yes \/ No[^|\n]*\| Yes/g)][0];
      return { findings: [
        q && { key: q[1], kind: 'differ', current: 'Yes', suggested: 'No', evidenceShows: 'problem', reason: `Photo shows a deficiency: ${q[2].trim()}`, evidencePhotos: [], confidence: 0.82 },
        // wrong direction (problem in the photos, "Yes" suggested): code must drop it
        h && { key: h[1], kind: 'differ', current: 'Yes', suggested: 'No', evidenceShows: 'no_problem', reason: 'Photo shows accumulated debris.', evidencePhotos: [], confidence: 0.8 },
      ].filter(Boolean) };
    }
    case 'narrative': {
      const ids = pick(/^- ([a-z]\d+): /gm, text);   // the question set as listed in the prompt
      return {
        answers: ids.map((id, i) => ({ id, answer: i % 3 === 0 ? '' : `answer ${id}`, inForm: i % 3 !== 0, inNarrative: i % 3 === 1, fieldKey: '' })),
        hazardousTenants: ids.includes('r1') ? ['restaurant'] : [],
        coverage: /Workers' Comp/.test(text) ? [{ coverage: "Workers' Comp", addressed: 'no', where: '', topics: 'employee safety' }] : [],
        draft: 'The risk is a two-story, joisted masonry (ISO-2) vacant building with an unfinished basement. The building is 0% occupied. The risk was built in [[confirm: year built]] and measures 14,450 square feet, excluding the basement. There have been no reported damages or losses. '
          + 'The exterior walls are concrete block with a brick veneer. The roof is wood joists with wood decking and a rubber membrane covering, in fair condition. The interior walls are sheetrock and the floors are tile over wood.\n\n'
          + 'The utilities remain on. Electric is BX cable with circuit breaker protection. The plumbing is copper and PVC. Heat is provided by a gas-fired boiler. The building is not sprinkler protected; fire extinguishers were noted in the common areas. '
          + 'Interior walking surfaces are uneven at the rear entrance and the drive-thru window is broken. Housekeeping and maintenance are fair. The overall structural condition of the building is fair.',
        issues: [{ type: 'contradiction', quote: 'housekeeping is good', formValue: 'Housekeeping satisfactory? No', meaningDiffers: true, problem: 'Form says otherwise.', fix: 'State the form value.', fieldKey: '', confidence: 0.9 },
                        { type: 'missing_required', quote: '', formValue: '', meaningDiffers: false, problem: 'Egress not described.', fix: 'Describe exits.', fieldKey: '', confidence: 0.7 },
                        { type: 'contradiction', quote: '100% vacant', formValue: '', meaningDiffers: false, problem: 'Bogus: agrees with form.', fix: '', fieldKey: '', confidence: 0.5 }] };
    }
    default: return {};
  }
}

export function startFakeOpenAI(port = 4599) {
  const calls = [];
  const srv = http.createServer((req, res) => {
    let b = ''; req.on('data', c => (b += c)); req.on('end', () => {
      const body = JSON.parse(b || '{}');
      const schema = body.response_format?.json_schema?.name;
      const text = (body.messages || []).map(m => typeof m.content === 'string' ? m.content : m.content.filter(c => c.type === 'text').map(c => c.text).join('\n')).join('\n');
      calls.push({ schema, model: body.model, images: (body.messages.at(-1).content || []).filter?.(c => c.type === 'image_url').length || 0 });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(answer(schema, text)) } }],
        usage: { prompt_tokens: Math.ceil(text.length / 4), completion_tokens: 300, prompt_tokens_details: { cached_tokens: 0 } } }));
    });
  });
  return new Promise(r => srv.listen(port, () => r({ srv, calls })));
}
