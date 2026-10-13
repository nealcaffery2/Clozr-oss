// Phosphor fill icons (MIT, phosphoricons.com), embedded so stage and TC
// markers stay offline. The tire mark is Material Design Icons (Apache 2.0);
// Phosphor's tire glyph is a racetrack. The glyph names are what Mark draws.

import { SELLER_STAGES, sellerStageGroup, type SellerStageGroup } from './stages';

export const STAGE_GLYPHS = {
  clipboard: "M200 32h-36.26a47.92 47.92 0 0 0-71.48 0H56a16 16 0 0 0-16 16v168a16 16 0 0 0 16 16h144a16 16 0 0 0 16-16V48a16 16 0 0 0-16-16m-72 0a32 32 0 0 1 32 32H96a32 32 0 0 1 32-32m32 128H96a8 8 0 0 1 0-16h64a8 8 0 0 1 0 16m0-32H96a8 8 0 0 1 0-16h64a8 8 0 0 1 0 16",
  handshake: "m254.3 107.91l-25.52-51.06a16 16 0 0 0-21.47-7.15l-24.87 12.43l-52.39-13.86a8.14 8.14 0 0 0-4.1 0L73.56 62.13L48.69 49.7a16 16 0 0 0-21.47 7.15L1.7 107.9a16 16 0 0 0 7.15 21.47l27 13.51l55.49 39.63a8.1 8.1 0 0 0 2.71 1.25l64 16a8 8 0 0 0 7.6-2.1l40-40l15.08-15.08l26.42-13.21a16 16 0 0 0 7.15-21.46m-54.89 33.37L165 113.72a8 8 0 0 0-10.68.61C136.51 132.27 116.66 130 104 122l43.24-42h31.81l27.21 54.41Zm-41.87 41.86l-58.12-14.53l-49.2-35.14l28-56L128 64.28l9.8 2.59l-45 43.68l-.08.09a16 16 0 0 0 2.72 24.81c20.56 13.13 45.37 11 64.91-5L188 152.66Zm-25.72 34.8a8 8 0 0 1-7.75 6.06a8 8 0 0 1-1.95-.24l-41.71-10.43a7.9 7.9 0 0 1-2.71-1.25l-26.35-18.82a8 8 0 0 1 9.3-13l25.11 17.94L126 208.24a8 8 0 0 1 5.82 9.7",
  megaphone: "M200 72h-39.8c-2.91-.17-53.62-3.74-101.91-44.24A16 16 0 0 0 32 40v160a16 16 0 0 0 26.29 12.25c37.77-31.68 77-40.76 93.71-43.3v31.72a16 16 0 0 0 7.12 13.33l11 7.33A16 16 0 0 0 194.5 212l11.77-44.36A48 48 0 0 0 200 72m-21 135.89v.11l-11-7.33V168h21.6ZM200 152h-32V88h32a32 32 0 1 1 0 64",
  userCheck: "m253.66 133.66l-32 32a8 8 0 0 1-11.32 0l-16-16a8 8 0 0 1 11.32-11.32L216 148.69l26.34-26.35a8 8 0 0 1 11.32 11.32M144 157.68a68 68 0 1 0-71.9 0c-20.65 6.76-39.23 19.39-54.17 37.17A8 8 0 0 0 24 208h168a8 8 0 0 0 6.13-13.15c-14.95-17.78-33.53-30.41-54.13-37.17",
  bank: "M248 208a8 8 0 0 1-8 8H16a8 8 0 0 1 0-16h224a8 8 0 0 1 8 8M16.3 98.18a8 8 0 0 1 3.51-9l104-64a8 8 0 0 1 8.38 0l104 64A8 8 0 0 1 232 104h-24v64h16a8 8 0 0 1 0 16H32a8 8 0 0 1 0-16h16v-64H24a8 8 0 0 1-7.7-5.82M144 160a8 8 0 0 0 16 0v-48a8 8 0 0 0-16 0Zm-48 0a8 8 0 0 0 16 0v-48a8 8 0 0 0-16 0Z",
  seal: "M225.86 102.82c-3.77-3.94-7.67-8-9.14-11.57c-1.36-3.27-1.44-8.69-1.52-13.94c-.15-9.76-.31-20.82-8-28.51s-18.75-7.85-28.51-8c-5.25-.08-10.67-.16-13.94-1.52c-3.56-1.47-7.63-5.37-11.57-9.14C146.28 23.51 138.44 16 128 16s-18.27 7.51-25.18 14.14c-3.94 3.77-8 7.67-11.57 9.14c-3.25 1.36-8.69 1.44-13.94 1.52c-9.76.15-20.82.31-28.51 8s-7.8 18.75-8 28.51c-.08 5.25-.16 10.67-1.52 13.94c-1.47 3.56-5.37 7.63-9.14 11.57C23.51 109.72 16 117.56 16 128s7.51 18.27 14.14 25.18c3.77 3.94 7.67 8 9.14 11.57c1.36 3.27 1.44 8.69 1.52 13.94c.15 9.76.31 20.82 8 28.51s18.75 7.85 28.51 8c5.25.08 10.67.16 13.94 1.52c3.56 1.47 7.63 5.37 11.57 9.14c6.9 6.63 14.74 14.14 25.18 14.14s18.27-7.51 25.18-14.14c3.94-3.77 8-7.67 11.57-9.14c3.27-1.36 8.69-1.44 13.94-1.52c9.76-.15 20.82-.31 28.51-8s7.85-18.75 8-28.51c.08-5.25.16-10.67 1.52-13.94c1.47-3.56 5.37-7.63 9.14-11.57c6.63-6.9 14.14-14.74 14.14-25.18s-7.51-18.27-14.14-25.18m-52.2 6.84l-56 56a8 8 0 0 1-11.32 0l-24-24a8 8 0 0 1 11.32-11.32L112 148.69l50.34-50.35a8 8 0 0 1 11.32 11.32",
  x: "M128 24a104 104 0 1 0 104 104A104.11 104.11 0 0 0 128 24m37.66 130.34a8 8 0 0 1-11.32 11.32L128 139.31l-26.34 26.35a8 8 0 0 1-11.32-11.32L116.69 128l-26.35-26.34a8 8 0 0 1 11.32-11.32L128 116.69l26.34-26.35a8 8 0 0 1 11.32 11.32L139.31 128Z",
  house: "M240 208h-16v-72l2.34 2.34A8 8 0 0 0 237.66 127l-98.35-98.32a16 16 0 0 0-22.62 0L18.34 127a8 8 0 0 0 11.32 11.31L32 136v72H16a8 8 0 0 0 0 16h224a8 8 0 0 0 0-16m-88 0h-48v-48a4 4 0 0 1 4-4h40a4 4 0 0 1 4 4Z",
  sparkle: "M208 144a15.78 15.78 0 0 1-10.42 14.94L146 178l-19 51.62a15.92 15.92 0 0 1-29.88 0L78 178l-51.62-19a15.92 15.92 0 0 1 0-29.88L78 110l19-51.62a15.92 15.92 0 0 1 29.88 0L146 110l51.62 19A15.78 15.78 0 0 1 208 144m-56-96h16v16a8 8 0 0 0 16 0V48h16a8 8 0 0 0 0-16h-16V16a8 8 0 0 0-16 0v16h-16a8 8 0 0 0 0 16m88 32h-8v-8a8 8 0 0 0-16 0v8h-8a8 8 0 0 0 0 16h8v8a8 8 0 0 0 16 0v-8h8a8 8 0 0 0 0-16",
  phone: "M231.88 175.08A56.26 56.26 0 0 1 176 224C96.6 224 32 159.4 32 80a56.26 56.26 0 0 1 48.92-55.88a16 16 0 0 1 16.62 9.52l21.12 47.15v.12A16 16 0 0 1 117.39 96c-.18.27-.37.52-.57.77L96 121.45c7.49 15.22 23.41 31 38.83 38.51l24.34-20.71a8 8 0 0 1 .75-.56a16 16 0 0 1 15.17-1.4l.13.06l47.11 21.11a16 16 0 0 1 9.55 16.62",
  tag: "M243.31 136L144 36.69A15.86 15.86 0 0 0 132.69 32H40a8 8 0 0 0-8 8v92.69A15.86 15.86 0 0 0 36.69 144L136 243.31a16 16 0 0 0 22.63 0l84.68-84.68a16 16 0 0 0 0-22.63M84 96a12 12 0 1 1 12-12a12 12 0 0 1-12 12",
  signature: "M80.3 120.26a58.3 58.3 0 0 1 .7-23.19C83.32 87 87.89 80 92.1 80c2.57 0 2.94.67 3.12 1c.88 1.61 4 10.93-12.63 46.52a29 29 0 0 1-2.29-7.26M232 56v144a16 16 0 0 1-16 16H40a16 16 0 0 1-16-16V56a16 16 0 0 1 16-16h176a16 16 0 0 1 16 16M84 160c2-3.59 3.94-7.32 5.9-11.14c10.34-.32 22.21-7.57 35.47-21.68c5 9.69 11.38 15.25 18.87 16.55c8 1.38 16-2.38 23.94-11.2c6 5.53 16.15 11.47 31.8 11.47a8 8 0 0 0 0-16c-17.91 0-24.3-10.88-24.84-11.86a7.83 7.83 0 0 0-6.54-4.51a8 8 0 0 0-7.25 3.6c-6.78 10-11.87 13.16-14.39 12.73c-4-.69-9.15-10-11.23-18a8 8 0 0 0-14-3c-8.88 10.94-16.3 17.79-22.13 21.66c15.8-35.65 13.27-48.59 9.6-55.3c-1.85-3.48-6.61-9.32-17.1-9.32c-12.44 0-22.42 11-26.69 29.46a75 75 0 0 0-.83 29.81c1.7 8.9 5.17 15.73 10.16 20.12c-3 5.81-6.09 11.43-9 16.61H56a8 8 0 0 0 0 16h.44c-4.26 7.12-7.11 11.59-7.18 11.69a8 8 0 0 0 13.48 8.62c.36-.55 5.47-8.57 12.29-20.31H200a8 8 0 0 0 0-16Z",
  refund: "M232 144a64.07 64.07 0 0 1-64 64H80a8 8 0 0 1 0-16h88a48 48 0 0 0 0-96H88v40a8 8 0 0 1-13.66 5.66l-48-48a8 8 0 0 1 0-11.32l48-48A8 8 0 0 1 88 40v40h80a64.07 64.07 0 0 1 64 64",
  dots: "M128 24a104 104 0 1 0 104 104A104.13 104.13 0 0 0 128 24M84 140a12 12 0 1 1 12-12a12 12 0 0 1-12 12m44 0a12 12 0 1 1 12-12a12 12 0 0 1-12 12m44 0a12 12 0 1 1 12-12a12 12 0 0 1-12 12",
  search: "M168 112a56 56 0 1 1-56-56a56 56 0 0 1 56 56m61.66 117.66a8 8 0 0 1-11.32 0l-50.06-50.07a88 88 0 1 1 11.32-11.31l50.06 50.06a8 8 0 0 1 0 11.32M112 184a72 72 0 1 0-72-72a72.08 72.08 0 0 0 72 72",
  star: "m234.29 114.85l-45 38.83L203 211.75a16.4 16.4 0 0 1-24.5 17.82L128 198.49l-50.53 31.08A16.4 16.4 0 0 1 53 211.75l13.76-58.07l-45-38.83A16.46 16.46 0 0 1 31.08 86l59-4.76l22.76-55.08a16.36 16.36 0 0 1 30.27 0l22.75 55.08l59 4.76a16.46 16.46 0 0 1 9.37 28.86Z",
  check: "M128 24a104 104 0 1 0 104 104A104.11 104.11 0 0 0 128 24m45.66 85.66l-56 56a8 8 0 0 1-11.32 0l-24-24a8 8 0 0 1 11.32-11.32L112 148.69l50.34-50.35a8 8 0 0 1 11.32 11.32",
  lightning: "m213.85 125.46l-112 120a8 8 0 0 1-13.69-7l14.66-73.33l-57.63-21.64a8 8 0 0 1-3-13l112-120a8 8 0 0 1 13.69 7l-14.7 73.41l57.63 21.61a8 8 0 0 1 3 12.95Z",
  moon: "M235.54 150.21a104.84 104.84 0 0 1-37 52.91A104 104 0 0 1 32 120a103.1 103.1 0 0 1 20.88-62.52a104.84 104.84 0 0 1 52.91-37a8 8 0 0 1 10 10a88.08 88.08 0 0 0 109.8 109.8a8 8 0 0 1 10 10Z",
  // Material Design Icons tire (Apache 2.0). Phosphor's tire is a racetrack.
  // This path uses a 24 viewBox; Mark switches for it.
  tire: "m19.66 9.64l-.36-.94l1.86-.7c-.92-2.12-2.56-3.82-4.62-4.86l-.8 1.78l-.92-.42l.8-1.8C14.5 2.26 13.28 2 12 2c-1.06 0-2.08.22-3.04.5l.68 1.84l-.94.36L8 2.84c-2.12.92-3.82 2.56-4.86 4.62l1.78.8l-.42.92l-1.8-.8C2.26 9.5 2 10.72 2 12c0 1.06.22 2.08.5 3.04l1.84-.68l.36.94l-1.86.7c.92 2.12 2.56 3.82 4.62 4.86l.8-1.78l.92.42l-.8 1.8c1.12.44 2.34.7 3.62.7c1.06 0 2.08-.22 3.04-.5l-.68-1.84l.94-.36l.7 1.86c2.12-.92 3.82-2.56 4.86-4.62l-1.78-.8l.42-.92l1.8.8c.44-1.12.7-2.34.7-3.62c0-1.06-.22-2.08-.5-3.04zm-5.36 7.9c-3.06 1.26-6.58-.18-7.84-3.24s.18-6.58 3.24-7.84s6.58.18 7.84 3.24a5.986 5.986 0 0 1-3.24 7.84",
  chat: "M232 128a104 104 0 0 1-152.88 91.82l-34.05 11.35a16 16 0 0 1-20.24-20.24l11.35-34.05A104 104 0 1 1 232 128",
  mail: "M224 48H32a8 8 0 0 0-8 8v136a16 16 0 0 0 16 16h176a16 16 0 0 0 16-16V56a8 8 0 0 0-8-8m-8 144H40V74.19l82.59 75.71a8 8 0 0 0 10.82 0L216 74.19z",
  note: "M208 32H48a16 16 0 0 0-16 16v160a16 16 0 0 0 16 16h108.69a15.92 15.92 0 0 0 11.31-4.69L219.31 168a15.92 15.92 0 0 0 4.69-11.31V48a16 16 0 0 0-16-16M96 88h64a8 8 0 0 1 0 16H96a8 8 0 0 1 0-16m32 80H96a8 8 0 0 1 0-16h32a8 8 0 0 1 0 16m-32-32a8 8 0 0 1 0-16h64a8 8 0 0 1 0 16Zm64 68.69V160h44.7Z",
  flame: "M143.38 17.85a8 8 0 0 0-12.63 3.41l-22 60.41l-24.16-23.41a8 8 0 0 0-11.93.89C51 87.53 40 116.08 40 144a88 88 0 0 0 176 0c0-59.45-50.79-108-72.62-126.15m40.51 135.49a57.6 57.6 0 0 1-46.56 46.55a7.7 7.7 0 0 1-1.33.11a8 8 0 0 1-1.32-15.89c16.57-2.79 30.63-16.85 33.44-33.45a8 8 0 0 1 15.78 2.68Z",
  eye: "M247.31 124.76c-.35-.79-8.82-19.58-27.65-38.41C194.57 61.26 162.88 48 128 48S61.43 61.26 36.34 86.35C17.51 105.18 9 124 8.69 124.76a8 8 0 0 0 0 6.5c.35.79 8.82 19.57 27.65 38.4C61.43 194.74 93.12 208 128 208s66.57-13.26 91.66-38.34c18.83-18.83 27.3-37.61 27.65-38.4a8 8 0 0 0 0-6.5M128 168a40 40 0 1 1 40-40a40 40 0 0 1-40 40",
  crown: "M248 80a28 28 0 1 0-51.12 15.77l-26.79 33L146 73.4a28 28 0 1 0-36.06 0l-24.03 55.34l-26.79-33a28 28 0 1 0-26.6 12L47 194.63A16 16 0 0 0 62.78 208h130.44A16 16 0 0 0 209 194.63l14.47-86.85A28 28 0 0 0 248 80M128 40a12 12 0 1 1-12 12a12 12 0 0 1 12-12M24 80a12 12 0 1 1 12 12a12 12 0 0 1-12-12m196 12a12 12 0 1 1 12-12a12 12 0 0 1-12 12",
  pause: "M128 24a104 104 0 1 0 104 104A104.13 104.13 0 0 0 128 24m-16 136a8 8 0 0 1-16 0V96a8 8 0 0 1 16 0Zm48 0a8 8 0 0 1-16 0V96a8 8 0 0 1 16 0Z",
  clock: "M128 24a104 104 0 1 0 104 104A104.11 104.11 0 0 0 128 24m56 112h-56a8 8 0 0 1-8-8V72a8 8 0 0 1 16 0v48h48a8 8 0 0 1 0 16",
  bell: "M221.8 175.94c-5.55-9.56-13.8-36.61-13.8-71.94a80 80 0 1 0-160 0c0 35.34-8.26 62.38-13.81 71.94A16 16 0 0 0 48 200h40.81a40 40 0 0 0 78.38 0H208a16 16 0 0 0 13.8-24.06M128 216a24 24 0 0 1-22.62-16h45.24A24 24 0 0 1 128 216",
  shield: "M208 40H48a16 16 0 0 0-16 16v56c0 52.72 25.52 84.67 46.93 102.19c23.06 18.86 46 25.27 47 25.53a8 8 0 0 0 4.2 0c1-.26 23.91-6.67 47-25.53C198.48 196.67 224 164.72 224 112V56a16 16 0 0 0-16-16m-88 56a8 8 0 0 1 16 0v40a8 8 0 0 1-16 0Zm8 88a12 12 0 1 1 12-12a12 12 0 0 1-12 12",
  dollar: "M160 152a16 16 0 0 1-16 16h-8v-32h8a16 16 0 0 1 16 16m72-24A104 104 0 1 1 128 24a104.11 104.11 0 0 1 104 104m-56 24a32 32 0 0 0-32-32h-8V88h4a16 16 0 0 1 16 16a8 8 0 0 0 16 0a32 32 0 0 0-32-32h-4v-8a8 8 0 0 0-16 0v8h-4a32 32 0 0 0 0 64h4v32h-8a16 16 0 0 1-16-16a8 8 0 0 0-16 0a32 32 0 0 0 32 32h8v8a8 8 0 0 0 16 0v-8h8a32 32 0 0 0 32-32m-76-48a16 16 0 0 0 16 16h4V88h-4a16 16 0 0 0-16 16",
  trophy: "M232 64h-24V48a8 8 0 0 0-8-8H56a8 8 0 0 0-8 8v16H24A16 16 0 0 0 8 80v16a40 40 0 0 0 40 40h3.65A80.13 80.13 0 0 0 120 191.61V216H96a8 8 0 0 0 0 16h64a8 8 0 0 0 0-16h-24v-24.42c31.94-3.23 58.44-25.64 68.08-55.58H208a40 40 0 0 0 40-40V80a16 16 0 0 0-16-16M48 120a24 24 0 0 1-24-24V80h24v32q0 4 .39 8Zm184-24a24 24 0 0 1-24 24h-.5a82 82 0 0 0 .5-8.9V80h24Z",
  warning: "M236.8 188.09L149.35 36.22a24.76 24.76 0 0 0-42.7 0L19.2 188.09a23.51 23.51 0 0 0 0 23.72A24.35 24.35 0 0 0 40.55 224h174.9a24.35 24.35 0 0 0 21.33-12.19a23.51 23.51 0 0 0 .02-23.72M120 104a8 8 0 0 1 16 0v40a8 8 0 0 1-16 0Zm8 88a12 12 0 1 1 12-12a12 12 0 0 1-12 12",
  info: "M128 24a104 104 0 1 0 104 104A104.11 104.11 0 0 0 128 24m-4 48a12 12 0 1 1-12 12a12 12 0 0 1 12-12m12 112a16 16 0 0 1-16-16v-40a8 8 0 0 1 0-16a16 16 0 0 1 16 16v40a8 8 0 0 1 0 16",
  buildings: "M239.73 208H224V96a16 16 0 0 0-16-16h-44a4 4 0 0 0-4 4v124h-16V32.41a16.43 16.43 0 0 0-6.16-13a16 16 0 0 0-18.72-.69L39.12 72A16 16 0 0 0 32 85.34V208H16.27A8.18 8.18 0 0 0 8 215.47a8 8 0 0 0 8 8.53h224a8 8 0 0 0 8-8.53a8.18 8.18 0 0 0-8.27-7.47M76 184a8 8 0 0 1-8.53 8a8.18 8.18 0 0 1-7.47-8.28v-15.45a8.19 8.19 0 0 1 7.47-8.27a8 8 0 0 1 8.53 8Zm0-56a8 8 0 0 1-8.53 8a8.19 8.19 0 0 1-7.47-8.28v-15.45a8.19 8.19 0 0 1 7.47-8.27a8 8 0 0 1 8.53 8Zm40 56a8 8 0 0 1-8.53 8a8.18 8.18 0 0 1-7.47-8.26v-15.47a8.19 8.19 0 0 1 7.47-8.26a8 8 0 0 1 8.53 8Zm0-56a8 8 0 0 1-8.53 8a8.19 8.19 0 0 1-7.47-8.26v-15.47a8.19 8.19 0 0 1 7.47-8.26a8 8 0 0 1 8.53 8Z",
  flag: "M232 56v120a8 8 0 0 1-2.76 6c-15.28 13.23-29.89 18-43.82 18c-18.91 0-36.57-8.74-53-16.85C105.87 170 82.79 158.61 56 179.77V224a8 8 0 0 1-16 0V56a8 8 0 0 1 2.77-6c36-31.18 68.31-15.21 96.79-1.12C167 62.46 190.79 74.2 218.76 50A8 8 0 0 1 232 56",
  calendar: "M208 32h-24v-8a8 8 0 0 0-16 0v8H88v-8a8 8 0 0 0-16 0v8H48a16 16 0 0 0-16 16v160a16 16 0 0 0 16 16h160a16 16 0 0 0 16-16V48a16 16 0 0 0-16-16m0 48H48V48h24v8a8 8 0 0 0 16 0v-8h80v8a8 8 0 0 0 16 0v-8h24Z",
  list: "M208 32H48a16 16 0 0 0-16 16v160a16 16 0 0 0 16 16h160a16 16 0 0 0 16-16V48a16 16 0 0 0-16-16M68 188a12 12 0 1 1 12-12a12 12 0 0 1-12 12m0-48a12 12 0 1 1 12-12a12 12 0 0 1-12 12m0-48a12 12 0 1 1 12-12a12 12 0 0 1-12 12m124 92h-88a8 8 0 0 1 0-16h88a8 8 0 0 1 0 16m0-48h-88a8 8 0 0 1 0-16h88a8 8 0 0 1 0 16m0-48h-88a8 8 0 0 1 0-16h88a8 8 0 0 1 0 16",
} as const;

export type StageGlyph = keyof typeof STAGE_GLYPHS;

const DEAL_GLYPH: Record<string, StageGlyph> = {
  Prospect: 'search',
  'Under Contract Seller': 'handshake',
  'Ready To Market': 'megaphone',
  'Buyer Under Contract': 'userCheck',
  'In Escrow': 'bank',
  Closed: 'seal',
  Terminated: 'x',
  'Realtor Referral': 'house',
};

const GROUP_GLYPH: Record<SellerStageGroup, StageGlyph> = {
  lead: 'sparkle',
  working: 'phone',
  offer: 'tag',
  contract: 'signature',
  closed: 'seal',
  dead: 'x',
  refund: 'refund',
  referral: 'house',
  other: 'dots',
};

/** Live-list statuses (buyers, vendors, older seller rows) that are not seller stages. */
const STATUS_GLYPH: Record<string, StageGlyph> = {
  new: 'sparkle',
  contacted: 'phone',
  qualified: 'check',
  offer_sent: 'tag',
  under_contract: 'handshake',
  closed: 'seal',
  lost: 'x',
  active: 'lightning',
  vip: 'star',
  preferred: 'star',
  inactive: 'moon',
};

const SELLER_LABELS = new Set(SELLER_STAGES.map((s) => s.label));

/** Which Phosphor glyph belongs next to a stage or status label. */
export function stageGlyph(label: string): StageGlyph {
  const raw = label.trim();
  if (DEAL_GLYPH[raw]) return DEAL_GLYPH[raw];
  if (SELLER_LABELS.has(raw)) return GROUP_GLYPH[sellerStageGroup(raw)];
  const key = raw.toLowerCase().replace(/[\s-]+/g, '_');
  if (STATUS_GLYPH[key]) return STATUS_GLYPH[key];
  if (/escrow/i.test(raw)) return 'bank';
  if (/terminat|\bdead\b|\blost\b/i.test(raw)) return 'x';
  if (/closed/i.test(raw)) return 'seal';
  if (/referral|realtor/i.test(raw)) return 'house';
  if (/contract/i.test(raw)) return 'handshake';
  if (/market/i.test(raw)) return 'megaphone';
  if (/offer/i.test(raw)) return 'tag';
  if (/refund/i.test(raw)) return 'refund';
  if (/lead|prospect|\bnew\b/i.test(raw)) return 'sparkle';
  return 'dots';
}

export const TC_GLYPH: StageGlyph = 'clipboard';

/** A label anywhere a square used to sit: stage, status, channel, priority, tool. */
export function markGlyph(label: string): StageGlyph {
  const raw = label.trim();
  const key = raw.toLowerCase().replace(/[_-]+/g, ' ');
  if (DEAL_GLYPH[raw] || SELLER_LABELS.has(raw)) return stageGlyph(raw);
  if (/tire/.test(key)) return 'tire';
  if (/^(tc|transaction|commitment)$/.test(key) || key.startsWith('tc ') || key.startsWith('transaction')) return 'clipboard';
  if (/critical|blocker|overdue|error|at risk|at-risk|risk/.test(key)) return 'flame';
  if (/warn|watch|caution/.test(key)) return 'warning';
  if (/success|good|vetted|qualified|live/.test(key)) return 'check';
  if (/vip|preferred/.test(key)) return 'crown';
  if (/blacklist|dnc|do not/.test(key)) return 'x';
  if (/pause|paused|inactive/.test(key)) return 'pause';
  if (/active/.test(key)) return 'lightning';
  if (/call|phone|talkr/.test(key)) return 'phone';
  if (/sms|text|chat|message/.test(key)) return 'chat';
  if (/mail|email|gmail/.test(key)) return 'mail';
  if (/note/.test(key)) return 'note';
  if (/offer|highest/.test(key)) return 'trophy';
  if (/net|fee|dollar|price|profit/.test(key)) return 'dollar';
  if (/fast|lightning/.test(key)) return 'lightning';
  if (/term|seal|closed/.test(key)) return 'seal';
  if (/compr|genius|lane|spark/.test(key)) return 'sparkle';
  if (/buyr|buyer|user/.test(key)) return 'userCheck';
  if (/deal machine|deal/.test(key)) return 'buildings';
  if (/calendar|appt|appointment/.test(key)) return 'calendar';
  if (/task|due|clock|follow/.test(key)) return 'clock';
  if (/info|system|mention/.test(key)) return 'info';
  if (/high|priority|urgent/.test(key)) return 'flag';
  if (/medium/.test(key)) return 'clock';
  if (/low/.test(key)) return 'moon';
  if (/prospect|lead|new|list|pin/.test(key)) return 'sparkle';
  if (/portal|view|eye/.test(key)) return 'eye';
  if (/purchase|escrow|bank/.test(key)) return 'bank';
  if (/walk/.test(key)) return 'calendar';
  if (/notif|bell/.test(key)) return 'bell';
  if (/shield|security|role|admin|owner/.test(key)) return 'shield';
  if (/campaign|market|megaphone/.test(key)) return 'megaphone';
  if (/dispo/.test(key)) return 'megaphone';
  if (/seller|people/.test(key)) return 'userCheck';
  if (/vendor|title/.test(key)) return 'buildings';
  if (/setting/.test(key)) return 'dots';
  return stageGlyph(raw);
}
