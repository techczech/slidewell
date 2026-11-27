import { basename } from 'node:path'

export function isPresentationId(id: string): boolean {
  return id.length > 0 && !id.startsWith('.') && !id.includes('\0') && basename(id) === id
}

export function slidePresentationId(itemId: string): string | null {
  const separator = itemId.lastIndexOf('#')
  return itemId.startsWith('slide:') && separator > 'slide:'.length ? itemId.slice('slide:'.length, separator) : null
}
