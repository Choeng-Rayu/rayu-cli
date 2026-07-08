import sharp from 'sharp'

// Original, hand-authored mascot illustration matching the reference design:
// a chubby blue-and-white pixel-art-style penguin/bird with blue crest
// feathers, blue cheek patches, a scarf with a "<>" code-icon badge, orange
// beak/feet. Colors sampled to match the reference: sky blue (#5EC8E8-ish),
// darker badge blue (#3A7FB5-ish), white body, orange (#F5A623-ish).
const svg = `
<svg width="512" height="512" viewBox="0 0 512 512" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="bodyGrad" x1="0%" y1="0%" x2="0%" y2="100%">
      <stop offset="0%" stop-color="#ffffff"/>
      <stop offset="100%" stop-color="#f2f6fa"/>
    </linearGradient>
    <linearGradient id="crestGrad" x1="0%" y1="0%" x2="0%" y2="100%">
      <stop offset="0%" stop-color="#7DD8F5"/>
      <stop offset="100%" stop-color="#4FB8E8"/>
    </linearGradient>
    <linearGradient id="wingGrad" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#5EC8E8"/>
      <stop offset="100%" stop-color="#3E9FD0"/>
    </linearGradient>
  </defs>

  <!-- ground shadow -->
  <ellipse cx="256" cy="452" rx="118" ry="14" fill="#000000" opacity="0.12"/>

  <!-- body (chubby oval) -->
  <ellipse cx="256" cy="322" rx="128" ry="106" fill="url(#bodyGrad)"/>

  <!-- feet (drawn after body so they sit visibly in front, like the reference) -->
  <rect x="203" y="404" width="28" height="26" rx="7" fill="#F5A623"/>
  <rect x="283" y="404" width="28" height="26" rx="7" fill="#F5A623"/>

  <!-- wing (right side, blue) -->
  <path d="M 352 260
           C 388 270, 402 310, 392 355
           C 384 388, 358 402, 336 396
           C 348 360, 350 300, 352 260 Z"
        fill="url(#wingGrad)"/>

  <!-- crest / hood (top of head, blue, sweeping up-left like the reference) -->
  <path d="M 190 150
           C 160 120, 165 70, 205 55
           C 235 44, 260 55, 268 80
           C 275 100, 268 118, 250 128
           C 270 132, 288 148, 292 172
           C 296 196, 284 218, 258 226
           C 220 236, 182 220, 168 188
           C 158 166, 165 158, 190 150 Z"
        fill="url(#crestGrad)"/>

  <!-- head (white face, round) -->
  <circle cx="240" cy="188" r="86" fill="url(#bodyGrad)"/>

  <!-- blue cheek patches -->
  <ellipse cx="178" cy="196" rx="30" ry="34" fill="#5EC8E8"/>
  <ellipse cx="292" cy="196" rx="34" ry="38" fill="#5EC8E8"/>

  <!-- re-cover center face area so cheeks read as side patches, not full overlay -->
  <ellipse cx="238" cy="200" rx="72" ry="70" fill="url(#bodyGrad)"/>

  <!-- blush circles -->
  <circle cx="190" cy="222" r="12" fill="#FFC7D6" opacity="0.85"/>
  <circle cx="292" cy="222" r="14" fill="#FFC7D6" opacity="0.85"/>

  <!-- eyes -->
  <circle cx="205" cy="188" r="17" fill="#1c1c1c"/>
  <circle cx="209" cy="182" r="5" fill="#ffffff"/>
  <circle cx="278" cy="188" r="17" fill="#1c1c1c"/>
  <circle cx="282" cy="182" r="5" fill="#ffffff"/>

  <!-- beak -->
  <path d="M 228 218 L 258 218 L 244 240 Z" fill="#F5A623"/>

  <!-- scarf band around the neck -->
  <path d="M 158 258
           C 200 288, 288 288, 326 258
           C 330 278, 328 296, 318 308
           C 270 330, 214 330, 168 308
           C 158 296, 154 278, 158 258 Z"
        fill="#4FB8E8"/>

  <!-- scarf badge (rounded rect) -->
  <rect x="212" y="270" width="64" height="52" rx="12" fill="#2E7DAE"/>
  <!-- "<>" code icon, matching the reference (plain angle brackets, no slash) -->
  <path d="M 233 284 L 220 296 L 233 308" stroke="#EAF6FC" stroke-width="5"
        fill="none" stroke-linecap="round" stroke-linejoin="round"/>
  <path d="M 255 284 L 268 296 L 255 308" stroke="#EAF6FC" stroke-width="5"
        fill="none" stroke-linecap="round" stroke-linejoin="round"/>
</svg>
`

const buf = Buffer.from(svg)
await sharp(buf)
  .png({ compressionLevel: 9 })
  .toFile(new URL('../assets/goose.png', import.meta.url).pathname)

console.log('wrote assets/goose.png')

const meta = await sharp(
  new URL('../assets/goose.png', import.meta.url).pathname,
).metadata()
console.log(JSON.stringify(meta, null, 2))
