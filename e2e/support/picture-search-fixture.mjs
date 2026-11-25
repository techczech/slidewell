import sharp from 'sharp'

export const PICTURE_TEXT_QUERY = 'a white rocket blasting off into outer space'
export const PICTURE_WORDS_QUERY = 'forest'
export const TEXT_MATCH_ID = 'slide:fixture-deck-4#5'
export const IMAGE_MATCH_ID = 'slide:fixture-deck-2#7'

const rocket = {
  title: 'Rocket launch',
  body: 'The spacecraft lifts off with a long plume of fire.',
  background: '#091431',
  figure: `<g fill="#fff5d5"><circle cx="155" cy="42" r="4"/><circle cx="509" cy="79" r="5"/>
    <circle cx="423" cy="143" r="4"/><circle cx="199" cy="166" r="5"/></g>
    <path d="M320 212q-36 33 0 86 36-53 0-86" fill="#ffae2e"/>
    <path d="M289 153l-32 79 47-23h32l47 23-32-79" fill="#db343d"/>
    <path d="M290 122q0-45 30-78 30 33 30 78v93h-60z" fill="#f7f6f0"/>
    <circle cx="320" cy="133" r="17" fill="#4f95da"/>`
}

const submarine = {
  title: 'Yellow submarine',
  body: 'A research vessel dives among bubbles on the ocean floor.',
  background: '#063c6d',
  figure: `<path d="M0 273q154-39 311 4t329-14v97H0z" fill="#086090"/>
    <g fill="none" stroke="#8fdef4" stroke-width="4"><circle cx="440" cy="85" r="12"/>
    <circle cx="463" cy="50" r="8"/><circle cx="483" cy="102" r="5"/></g>
    <rect x="176" y="145" width="273" height="92" rx="46" fill="#ffd52f"/>
    <path d="M271 145v-42h58v42m-34-43V72h32" fill="none" stroke="#ffd52f" stroke-width="15"/>
    <path d="M177 185l-38-33v68z" fill="#f09525"/>
    <g fill="#124f78"><circle cx="245" cy="189" r="16"/><circle cx="313" cy="189" r="16"/>
    <circle cx="381" cy="189" r="16"/></g>`
}

const targetSubjects = { [TEXT_MATCH_ID]: rocket, [IMAGE_MATCH_ID]: submarine }

const distractors = [
  {
    title: 'Pine forest', body: 'Evergreen trees grow high on a hillside.', background: '#c3e8cb',
    figure: `<path d="M0 270q280-152 640-35v85H0z" fill="#69a265"/>
      <path d="M139 258L218 79l79 179zM266 258L346 52l80 206zM403 258L471 104l68 154z" fill="#146142"/>`
  },
  {
    title: 'Orchard harvest', body: 'Three red apples in a row on a table.', background: '#f3bd9b',
    figure: `<g fill="#c72e31"><circle cx="172" cy="178" r="64"/>
      <circle cx="320" cy="178" r="64"/><circle cx="468" cy="178" r="64"/></g>
      <path d="M172 123q10-56 48-52-11 45-48 52m148 0q10-56 48-52-11 45-48 52m148 0q10-56 48-52-11 45-48 52" fill="#307943"/>`
  },
  {
    title: 'Concert programme', body: 'A grand piano is set out for a recital.', background: '#d0baf1',
    figure: `<path d="M113 127h364q59 0 59 54H113zM141 180h17v90h-17zm350 0h17v90h-17z" fill="#2d164c"/>
      <path d="M135 122L463 51l4 16-326 71z" fill="#2d164c"/>
      <path d="M141 146h119v20H141z" fill="#fff"/>`
  },
  {
    title: 'Basketball drill', body: 'Players practise passing and shooting on an indoor court.', background: '#f2dfb2',
    figure: `<circle cx="320" cy="173" r="103" fill="#ef7926" stroke="#472717" stroke-width="6"/>
      <path d="M217 173h206M320 70v206M250 97q102 76 0 152m140-152q-102 76 0 152" fill="none" stroke="#472717" stroke-width="6"/>`
  }
]

function render({ background, figure }, caption, offset = 0) {
  return `<svg width="640" height="360" xmlns="http://www.w3.org/2000/svg">
    <rect width="640" height="360" fill="${background}"/>
    <g transform="translate(${offset} 0)">${figure}</g>
    <rect y="305" width="640" height="55" fill="#171821"/>
    <text x="24" y="341" font-size="25" font-family="sans-serif" fill="#fff">${caption}</text>
  </svg>`
}

export function describePictureSlide(deck, order) {
  const id = `slide:fixture-deck-${deck + 1}#${order}`
  const subject = targetSubjects[id] ?? distractors[(deck + order) % distractors.length]
  const heading = `${subject.title} ${deck + 1}.${order}`
  return { heading, body: subject.body, svg: render(subject, heading, ((order + deck) % 9 - 4) * 4) }
}

export async function writePictureQueryImage(path) {
  // A shifted illustration with a different caption gives the well image its own bytes.
  await sharp(Buffer.from(render(submarine, 'Ocean research vessel', 17))).webp().toFile(path)
}
