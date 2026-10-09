// Vite imports a file's text with the ?raw suffix (used for the hidden picture-search page script).
declare module '*?raw' {
  const text: string
  export default text
}
