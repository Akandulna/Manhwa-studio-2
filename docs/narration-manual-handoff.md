# Prohibited-content narration handoff

The ordinary Narration **Replace** dialog also offers **Create Hinglish with prompts** on the Hindi tab
(**Create with prompts** on English). This uses the same copyable manual steps without requiring a prohibited-content
receipt. Hindi has three steps: Scene notes, Write the Hinglish, and Final Hinglish check. The first prompt includes
the saved English source; no images need to be attached. Paste the complete final SCRIPT/SUMMARY reply with its
scene markers. Saving validates the reply, removes the markers from spoken narration, retains its summary, and
uses the normal backup/reset/send path. If the English source changed after the prompts were opened, refresh the
prompts before saving. Plain-script replacement remains available through **Use plain script**.

When AI Studio reports prohibited or blocked content during English or Hinglish narration, the phone stops the run rather than retrying that rejection. It keeps the conversation and writes a language-specific `script.blocked.json` / `script.hi.blocked.json` beside the chapter’s scripts. The handoff records the failure time, stage, account, retained conversation URL, and (for Hinglish) the English-source hash. Ordinary transient generation errors retain their existing retry behavior.

The scripts receipt carries these handoffs separately from completed scripts. Manhwa Studio shows “Needs manual completion” in the Narration Library and “Prohibited content” with a Continue manually button on the affected chapter and language. Restarted series facts are filtered before handoffs are mapped. A later phone save or a successful local replacement resolves the warning; a blocked chapter is never counted as a completed script.

Continue manually opens the retained conversation link and accepts complete SCRIPT/SUMMARY sections or a passed final-review JSON response. Notes and unresolved reviews are rejected. Hinglish must remain in Devanagari, match the English source, retain complete scene coverage, and satisfy the existing chapter length limits. Saving strips section and scene bookkeeping, keeps summary/closing continuity, and uses the existing replacement backup/reset and phone-sync path. First-chapter English ABOUT content is also retained and shared. A failed phone upload can be retried without replacing the script again or losing the pasted output.

Validation: Android Debug and Beta offline unit suites; narration-manual, replacement, receipt and relay regression tests; server/client TypeScript checks; AI Studio/popup script fixtures; browser checks of the actual chapter warning and dialog with save requests intercepted. Nord runs `1.0.229-beta.20261111-manual-handoff`.

The previously observed chapter 15 failure for I Became a Cheat-Level Skill Thief was backfilled from its recorded live-test evidence, with the original conversation URL and verified unchanged English source. The phone’s real receipt and Studio’s UI now expose that handoff. The browser verification did not save fabricated narration or alter the chapter’s scripts.
