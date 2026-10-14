// The words of "About the sorter" (the panel behind the round "i" button in Review's strip and in Auto sorting › Training)
// and of the notice Review's strip shows after a retrain. One place for all of it, so a writer can fill it in without
// touching a component.
//
// Shape (fixed; components read it):
//   - SORTER_ABOUT.sections, in this order: what it looks at, where it learns from, how training works, how the rules by
//     app and window are made, where it is stored, what leaves your Mac. Each: a heading, paragraphs, and optional `live`
//     rows, each a label plus a slot the panel fills from the sorter's status.
//   - Live slots: choices, lastTrained, sureAt, retrain. Their values are worded by SORTER_ABOUT.values.
//   - RETRAIN_NOTICE: one template per piece of the notice line. {name} in a template is replaced by a number or a time.
//
// Facts for the writer: the sorter fact sheet handed over with the copy brief (outside the repo).
// Copy written from that fact sheet on 2026-10-14.

export type AboutLiveSlot = 'choices' | 'lastTrained' | 'sureAt' | 'retrain'

export type AboutSection = {
  id: 'looks-at' | 'learns-from' | 'training' | 'rules' | 'stored' | 'leaves-mac'
  heading: string
  paragraphs: string[]
  live?: Array<{ label: string; slot: AboutLiveSlot }>
}

export const SORTER_ABOUT = {
  title: 'About the sorter',
  intro:
    'The sorter looks at each screenshot and proposes to keep it or throw it away, using the keep and throw-away choices you have already made. Screenshots it is unsure about are left for you to look at.',
  close: 'Close ✕',
  sections: [
    {
      id: 'looks-at',
      heading: 'What it looks at',
      paragraphs: [
        'The main input is the picture. EmbeddingGemma 2 (ONNX, fp16, text and vision encoders only) turns each screenshot into 768 numbers. It runs on this Mac\'s GPU. The model is not bundled with SlideWell: it is downloaded from Hugging Face (about 910 MB) when you press Download in Settings › Picture search, and training will not start without it.',
        'The rules also read the app name, the window title (taken from CleanShot file names, so often empty), the text found by OCR and the file name. Capture time is not an input. It is used to group related screenshots for the held-back test and to choose the sort period.',
        'A screenshot that looks like one you already kept (the same picture, or the same thing) is nudged towards throw away. That nudge never decides on its own.',
        'The line "Looks like 3 of 5 nearby screenshots you kept" explains a card and does not decide anything. "Nearby" means similar-looking: the five of your choices whose pictures are closest, read by majority. It appears when the app line (see the rules section) does not apply and at least five of your choices have stored picture numbers.'
      ]
    },
    {
      id: 'learns-from',
      heading: 'Where it learns from',
      paragraphs: [
        'A screenshot counts as kept when it is in the well or when Triage has it as included. It counts as thrown away when Triage has it as excluded. Review and rounds write the same decisions Triage does, so there is no separate record of answers.',
        'A Keep counts as something the sorter learns from only once the screenshot is imported. Until then it is staged. A Keep on a file that is not on this Mac is saved but joins the well, and the sorter, when Triage imports it. A Throw away counts at once.',
        'Skip writes nothing. Undo restores the earlier decision, which can take a choice away again. A choice also needs a picture that can be read on this Mac.',
        'Testing needs at least 92 choices, 46 kept and 46 thrown away.'
      ],
      live: [{ label: 'Choices it learned from', slot: 'choices' }]
    },
    {
      id: 'training',
      heading: 'How training works',
      paragraphs: [
        'The classifier is logistic regression with L2 regularisation, fitted on the 768 numbers per screenshot. It is written in TypeScript with no machine-learning library. Fitting is full-batch gradient descent with Adam (learning rate 0.05, 300 epochs). Keep and throw away are weighted equally whatever your mix. The regularisation strength is chosen by cross-validation, usually five folds, and related screenshots are never split across folds. The probabilities are calibrated (Platt or isotonic, whichever has the lower cross-validated Brier score). The trained model is stored as plain JSON and trains in a worker thread, so the app stays responsive.',
        'Each training embeds your choices, groups related screenshots and holds back about a fifth of each kind. Screenshots are related when their pictures are at least 0.95 similar, or when they share an app and window title and were taken within five minutes. Whole groups are held back together. The model is trained on the rest and measured on the held-back screenshots, for the rules and model together and for the rules alone. The model the sorter then uses is trained again on all your choices.',
        'A screenshot counts as sure when the combined chance of throw away is at least 90%, or the chance of keep is at least 70%. Anything in between needs a look. When unsure, the sorter keeps: only sure throwaways go to Throwaway. The throw-away threshold cannot be set below 85%. The live rows below show what is in use.',
        '"How many is enough?" retrains on growing parts of your choices and tests each on the same held-back screenshots, to show whether more choices still help.',
        'Retraining by itself starts after every ten answers. It is on by default and waits while the Mac is on battery unless you allow it. It also waits while a sort is running and until there are enough choices to test. A failed retrain is not tried again until you give another answer.',
        'A retrain trains, tests and re-scores. Re-scoring changes only proposals that were unsure, on screenshots you have not decided yet. Sure proposals are never touched, no new proposals are added and no cloud model is asked.'
      ],
      live: [
        { label: 'Last trained', slot: 'lastTrained' },
        { label: 'Counts as sure at', slot: 'sureAt' },
        { label: 'Retrains by itself', slot: 'retrain' }
      ]
    },
    {
      id: 'rules',
      heading: 'How the rules by app and window are made',
      paragraphs: [
        'The built-in rules each lean towards keep or throw away, with a confidence between 0.5 and 1 and a reason. A Claude or ChatGPT answer leans keep (0.8). A Terminal window with an error leans throw away (0.9). When a keep rule and a throw-away rule both fit, keep wins.',
        'You can set your own rule for an app, "usually keep" or "usually throw away", in Auto sorting › What the sorter goes by. Your rule replaces every built-in rule that goes by that app name or window title, with a strength of 0.85. Rules that go by text or look still apply. The sorter suggests a rule when you have made at least 20 decisions from an app and at least 85% went one way. Changing a rule sorts nothing: the next sort uses it, and unattended sorting waits until the sorter has been trained again.',
        'A rule does not override the picture. The rule and the picture are added together on the log-odds scale, and with a picture a rule alone never decides. A screenshot without picture numbers is decided by the rule alone, and only if the rule\'s own confidence clears the thresholds. A card says "by rules" when the rule alone would have made the same call, and "by your history" otherwise. "History" here means the picture model.',
        'The line "You kept 0 of the last 20 from Google Chrome" explains a card and is not a rule. It appears when the app is known and you have made at least five decisions from it, counts your last 20 or fewer from that app, and takes precedence over the "nearby screenshots" line.'
      ]
    },
    {
      id: 'stored',
      heading: 'Where it is stored',
      paragraphs: [
        'Sorter data lives in the well folder (by default ~/SlideWell/well). triage.db there holds the proposals, the runs, the cloud answers, your Triage decisions (the sorter reads these and never writes them) and the trained classifier with its accuracy report. Kept screenshots are in well.db and as copied files in the well.',
        'The picture numbers are in picture-search.db, beside well.db and triage.db. The downloaded model files are in the app data folder, under models/embeddinggemma-2-onnx-fp16.',
        'Settings are in config.json in the app data folder: the retrain switches, the record of the last retrain, the "How many is enough?" results, your app rules, the last run and the cloud settings. Cloud API keys are encrypted there with the system keychain and are never shown again.',
        'Throwing a screenshot away records a state. It does not delete or move the file.'
      ]
    },
    {
      id: 'leaves-mac',
      heading: 'What leaves your Mac',
      paragraphs: [
        'The local sorter makes no network call. The only download is the picture model from huggingface.co, and it starts when you press Download.',
        'The cloud step is off until you turn it on in Settings and confirm a dialog that shows how many screenshots, the estimated cost and which company. Saving a key does not turn it on. The providers are OpenAI (gpt-6-luna, the default) and Anthropic (claude-haiku-5-5), and you agree to each separately.',
        'Only screenshots the sorter is unsure about are sent. For each one it sends the picture, shrunk to at most 1456 pixels on the long edge and saved as JPEG at quality 80, the app name and window title when known, and a short id. It does not send OCR text, the file name, the path or your decisions. OpenAI requests ask OpenAI not to keep the response.',
        'Sending happens in a nightly batch at 02:00 by default, only while the app is open and only if the cloud step and the nightly switch are on, or when you press Sort now and confirm a second time. At most 300 screenshots go in one night window. Each provider is asked about a screenshot once, and the answer is stored and reused. Second opinions from the other provider have their own switch. Retraining never asks a cloud model.'
      ]
    }
  ] satisfies AboutSection[],
  values: {
    choices: '{choices} ({kept} kept, {thrownAway} thrown away)',
    noChoices: 'none counted yet',
    lastTrained: '{when}',
    notTrained: 'not trained yet',
    sureAt: '{sure}%',
    sureAtSplit: 'keep {keep}%, throwaway {throwaway}%',
    sureUnknown: 'known after the first training',
    retrainOn: 'on, after every {every} answers',
    retrainOff: 'off',
    onBattery: 'also on battery',
    notOnBattery: 'not on battery'
  }
} as const

/** The pieces of the notice after a retrain, each its own slot. Exactly one of moved / nothingMoved / notChecked is shown. */
export const RETRAIN_NOTICE = {
  when: 'Retrained {when}',
  learnedFrom: 'using {choices} of your choices.',
  moved: 'Of the screenshots it was unsure about, {moved} are now sure: {keep} to keep, {throwaway} to throw away.',
  nothingMoved: 'None of the screenshots it was unsure about are sure yet.',
  notChecked: 'It could not check whether any unsure screenshots became sure.',
  stillNeed: 'Screenshots still needing a look: {needALook}.',
  showThem: 'Show them',
  dismiss: 'Dismiss ✕'
} as const

/** Replace each {name} in a template by its value; a name with no value is left as written. */
export function fillCopy(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (all, k: string) => (k in values ? String(values[k]) : all))
}
