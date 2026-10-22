# MFC-GALLERY-2: downloading the official gallery photos (design)

Part 1 (fc-aggregation `gallery:backfill`) recorded, for every stored MFC item page, the ordered gallery as one
`galleryImages` claim: `{entries:[{position, src, w, h}]}`. Nothing was downloaded. This is the part that downloads,
through the process every other image already takes. Ross's rules (10-20): files take the NORMAL process, no shortcut;
cookie-less plain GETs of the static host; its own per-host pacing; holdings first; auto-pause on 403/429/challenge;
the deployed rate is config (desk IMGRATE, Ross: 3 files/s, `intervalMs` 333).

## Why the image lane skipped them (so the lift is deliberate)

| limit | where | effect on MFC |
| --- | --- | --- |
| role: `/upload/pictures/` is role `user` | scraper-rulesets `src/mfc/index.ts:537`, `image-tiers.ts:32`; declined at `imageRefs.ts:105` | every official picture skipped; only the `/upload/items/` plate was fetched |
| cap 12 per item | `imageCaptureHook.ts:48`, `imageRefs.ts:135` | longest holdings gallery is 100 |
| runs only after an extraction | `scrapeQueue.ts:926`, `assembleImageCapture.ts:255` | stored pages are never revisited |

## The seam: the scraper, through the SAME hook

The scraper owns the whole normal process: `createImageCaptureHook` (`imageCaptureHook.ts:310`) -> `normalizeImageRefs`
-> `chooseImageLane` (`imageHostPolicy.ts:285`) -> `paceImageBytesByHost` (`imageBytesPacing.ts:80`) -> the bytes
guards (32 MiB cap `imageBytes.ts:141`, magic-byte sniff `:285`, SVG refused `:277`; counted notImage / tooLarge /
unsupported at `imageCaptureHook.ts:501-520`) -> `CaptureSink` (content-addressed raw original, `captureSink.ts:165`,
prefix `raw-img/`) -> `ReportCapture` (`captureReporter.ts:236`) -> fc-aggregation `capture-writer.ts` (raw.blob,
raw.capture lane asset, `product_image` role/position/state `captured`) -> the media.v1 lease (`derivative-writer.ts:112`)
-> media-manager clean copy and mask -> only derivatives are served. The driver adds nothing to that chain and writes
no row itself; it only decides WHICH urls the hook is asked for, in what order, and when to stop.

```
fc-aggregation  gallery:worklist  --(JSONL on the job's volume)-->  scraper  gallery:capture
  galleryImages claims, ranked                                        driver -> hook.capture() -> sink -> ReportCapture
  holdings 0/1/2, figures 5, rest 9                                   ledger (settled urls, pause marker) on the same volume
```

The scraper must not read the spine database, so the work list is a file the operator mounts (a PVC, like
`backfill-captures-state`). It is generated read-only by `npm run gallery:worklist` (fc-aggregation).

## What changes in the scraper

1. **Per-host rate seam** (`imageHostRates.ts`). `IMAGE_HOST_RATE_JSON='{"static.myfigurecollection.net":{"intervalMs":333}}'` (Ross, IMGRATE b: 3 files/s)
   feeds the image limiter (`assembleImageCapture.ts:171`, today `new HostRateLimiter(() => undefined)`: a 2,067 ms base
   that speeds up toward 274 ms). A row pins base = min = interval, so success never speeds it up; 429/503 still back it off.
   IMGRATE is this one number.
2. **Host policy row** (config, `IMAGE_HOST_POLICY_JSON`): `{"static.myfigurecollection.net":{"lane":"http","egress":"direct"}}`.
   Without it an on-store host inherits MFC's declared transport (`imageHostPolicy.ts:300-303`). The http lane sends
   no cookies of its own (`httpBytesFetch.ts` header). The driver composes an http-only router, so any other lane is
   `unsupported`, and it also refuses to start unless the policy resolves every allowed host to http + direct.
3. **Gallery driver** (`galleryDriver.ts`): reads the work list in file order; skips urls the ledger has settled; builds one
   `ImageCaptureRequest` per item whose synthetic `describeImages` returns `{url, role:'gallery', position, sourceClass}`;
   awaits `hook.capture()` (sequential, one item at a time); observes every fetch; settles stored / gone urls.
   `IMAGE_MAX_PER_ITEM=100` for this process only. The item's `contentLevel` rides the ref (fail closed to `unknown`).
   `sourceClass` is config (`GALLERY_SOURCE_CLASS`). Ross ruled (desk GALSRC b): the MFC official gallery is `manufacturer_press`, set in the Job env below; the code default stays `unknown`, so a Job that forgets the setting claims nothing.
4. **Auto-pause**: N consecutive blocked fetches (403, 429, 503, `cf-mitigated`, a 2xx that is not an image, a cooling
   host) stop the run and write a pause marker (default 3 and 6 h); the next run refuses until it lapses or `--resume`.
5. **Probe** (`--probe [N=20]`): the first N files of the work list through the real hook and sink, with evidence per
   request (status, type, size, header NAMES sent, set-cookie seen, cf-mitigated/cf-ray, redirect) and a verdict. PASS only if
   every request is a 200 image on the allowed host, no cookie or authorization header was sent, no challenge signal,
   no redirect off-host.
6. **Entry**: `npm run gallery:capture` (Job/CronJob, same image as the scraper). Exit 0 done, 3 paused, 4 refused
   (lane disabled or policy wrong), 5 probe failed, 2 bad arguments, 1 crash.

## Politeness and failure behaviour

- One request in flight, spaced by the host rate; no retries inside a run (a failed url is simply not settled and the next run
  tries it again, after the pause if one was set).
- Settled = stored (or already stored by hash) or permanently gone (404/410) or over the size cap. Never settled: 403, 429,
  5xx, timeouts, non-image 2xx, a sink failure in the item.
- Restart safe: the ledger is append-only JSONL; re-running the same work list fetches nothing already settled.
- Hands-off: the deployed job is the only thing that ever contacts the static host. Nothing here is run from a workstation.

## Rollout (nothing applied by this unit)

1. Merge; roll the scraper image. 2. Mount the work list and a small PVC. 3. Probe Job (`--probe 20`) -> read the verdict.
   If challenged, the fallback is the residential lane at a lower rate (a policy row, not code). 4. Holdings only
   (`--max-files` staged), then figures, then the rest. Desk IMGRATE sets `intervalMs`: Ross chose 333 = 3 files/s (holdings, 14,346 files, about 1.3 h;
   the whole catalogue, about 1.7M files, about 6.6 days).

## Derive side (not this unit, but a precondition)

media-manager's clean copy (`app/workers/mask_seed.py`, branch feat/mm-report-1) is the minimal one; the byte and pixel caps
before decode (its I8 unit) have not landed and `mask_batch.py:806` decompresses without a size cap. Land them before the
bulk run.

## Job sketch (for fc-infra; not applied by this unit)

```
# one-shot Job, scraper image, no npm in the image: node dist/...
args: ["node","dist/services/images/galleryCaptureCli.js","--probe","20"]      # first run
args: ["node","dist/services/images/galleryCaptureCli.js","--max-files","20000","--max-minutes","330"]   # staged real runs
env:
  PERSIST_RAW_IMAGES: "true"            # the lane must be on; the driver refuses to fetch what would be dropped
  REPORT_CAPTURES: "true"               # + INGEST_BASE_URL, RAW_STORE_S3_* exactly as the scraper Deployment has them
  IMAGE_HOST_POLICY_JSON: '{"static.myfigurecollection.net":{"lane":"http","egress":"direct"}}'
  IMAGE_HOST_RATE_JSON:   '{"static.myfigurecollection.net":{"intervalMs":333}}'      # desk IMGRATE b: 3 files/s, no speed-up
  GALLERY_ALLOWED_HOSTS: static.myfigurecollection.net   # REQUIRED: no host is built in (hands-off plan C1), the run exits 2 without one
  GALLERY_WORKLIST_PATH: /state/wl.jsonl     # from `npm run gallery:worklist` (fc-aggregation)
  GALLERY_LEDGER_PATH:   /state/ledger.jsonl
  GALLERY_SOURCE_CLASS:  manufacturer_press   # desk GALSRC b: the MFC official gallery
volumes: a small PVC at /state (the work list ~170 MB for the whole catalogue, the ledger grows ~100 bytes a file)
network: egress 443 to static.myfigurecollection.net and the raw store, plus the ingest listener, as the scraper has it
```

Operator flow: run `gallery:worklist`, copy the file to the PVC, run the probe Job and read `PROBE PASS|FAIL` (exit 5 on
anything but PASS), then run staged real Jobs until the list is done. A block pauses the Job (exit 3) and writes the marker;
`--resume` clears it deliberately.
