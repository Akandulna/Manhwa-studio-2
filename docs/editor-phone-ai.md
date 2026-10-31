# Editor 2.0 phone automation providers

Phone Status → Run automation → Editor 2.0 timelines offers ChatGPT or AI Studio and Small batches or Full package. Each phone reports its supported providers and saved settings. Older receipts show the controls disabled with an update message; their original Editor start remains supported. Editor settings stay separate from Image Clipper.

Update Sleeper-Cell on the worker phones and refresh Phone Status. AI Studio uses the model selected in that browser profile. Sign in before starting. Gemini Apps is excluded from Editor because its prompt text limit prevents full crop metadata from being pasted.

The server forwards the provider and explicit batch setting to every recipient, validating all recipients before sending a split. It refuses a provider or batch change on an active Editor run. The relay preserves these options for immediate delivery and reconnect, including `smallBatches: false`.

Deployment requires both the updated Manhwa Studio server/client and the updated relay Worker. An old Worker drops Editor provider and batch options. Do not use AI Studio remote starts until the relay update is deployed.

Validation:

```sh
cd server
npm test -- src/services/__tests__/phoneRelay.test.ts tests/client/editorAutomation.test.tsx
npx tsc --noEmit
cd ../client
npx tsc --noEmit --incremental false
cd ../relay
npm run typecheck
# In a separate terminal, start an isolated local relay:
npx wrangler dev --local --port 8795 --persist-to /tmp/editor-relay-fixture --var RELAY_TOKEN:editor-local-check
# Then run the delivery/reconnect fixture:
node scripts/editor-automation-check.mjs
```
