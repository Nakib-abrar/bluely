import { describe, expect, it } from 'vitest'
import { extractJsonObject, extractJsonValue, stripTrailingCommas } from '@main/ai/json'

describe('extractJsonObject', () => {
  it('parses a plain object', () => {
    expect(extractJsonObject('{"a": 1, "b": [1, 2]}')).toEqual({ a: 1, b: [1, 2] })
  })

  it('strips ```json fences', () => {
    expect(extractJsonObject('```json\n{"title": "Hi"}\n```')).toEqual({ title: 'Hi' })
    expect(extractJsonObject('```\n{"title": "Hi"}\n```')).toEqual({ title: 'Hi' })
    expect(extractJsonObject('Here you go:\n```JSON\n{"x": true}\n```\nAnything else?')).toEqual({
      x: true,
    })
  })

  it('finds the object inside prose before and after', () => {
    const text =
      'Sure! Here are the notes: {"title": "Pricing call", "keyPoints": ["a"]} Hope it helps.'
    expect(extractJsonObject(text)).toEqual({ title: 'Pricing call', keyPoints: ['a'] })
  })

  it('returns the outermost object, not a nested one', () => {
    const text = 'Result: {"items": [{"text": "Send deck", "owner": null}], "meta": {"n": 1}} done'
    expect(extractJsonObject(text)).toEqual({
      items: [{ text: 'Send deck', owner: null }],
      meta: { n: 1 },
    })
  })

  it('ignores braces and escaped quotes inside strings', () => {
    const text = 'x {"body": "Use {curly} braces and a \\"quote\\" } here", "n": 2} y'
    expect(extractJsonObject(text)).toEqual({
      body: 'Use {curly} braces and a "quote" } here',
      n: 2,
    })
  })

  it('skips a non-JSON brace block in prose before the real object', () => {
    const text = 'Fill in {name} first. {"subject": "Hello", "body": "Hi"}'
    expect(extractJsonObject(text)).toEqual({ subject: 'Hello', body: 'Hi' })
  })

  it('tolerates trailing commas before } or ]', () => {
    expect(extractJsonObject('{"a": [1, 2,], "b": {"c": 3,},}')).toEqual({ a: [1, 2], b: { c: 3 } })
    expect(extractJsonObject('{"a": "x,}",}')).toEqual({ a: 'x,}' })
  })

  it('returns null for garbage, arrays, truncated JSON and non-strings', () => {
    expect(extractJsonObject('no json here')).toBeNull()
    expect(extractJsonObject('')).toBeNull()
    expect(extractJsonObject('   ')).toBeNull()
    expect(extractJsonObject('[1, 2, 3]')).toBeNull()
    expect(extractJsonObject('{"title": "cut off')).toBeNull()
    expect(extractJsonObject('{not: valid}')).toBeNull()
    expect(extractJsonObject(null)).toBeNull()
    expect(extractJsonObject(undefined)).toBeNull()
  })

  it('handles a byte-order mark and an unterminated fence', () => {
    expect(extractJsonObject('﻿{"a": 1}')).toEqual({ a: 1 })
    expect(extractJsonObject('```json\n{"a": 1}')).toEqual({ a: 1 })
  })
})

describe('stripTrailingCommas', () => {
  it('only removes commas outside strings', () => {
    expect(stripTrailingCommas('{"a": ",]", "b": [1,\n ],}')).toBe('{"a": ",]", "b": [1\n ]}')
  })
})

describe('extractJsonValue', () => {
  it('returns a top-level array instead of its first element', () => {
    const text = '[{"text":"Send the deck","owner":"Me"},{"text":"Book a demo"}]'
    expect(extractJsonObject(text)).toEqual({ text: 'Send the deck', owner: 'Me' })
    expect(extractJsonValue(text)).toEqual([
      { text: 'Send the deck', owner: 'Me' },
      { text: 'Book a demo' },
    ])
    expect(extractJsonValue('```json\n[1, 2,]\n```')).toEqual([1, 2])
    expect(extractJsonValue('Here: []')).toEqual([])
  })

  it('still prefers objects, and skips a bracketed aside in prose', () => {
    expect(extractJsonValue('{"items": [1]}')).toEqual({ items: [1] })
    expect(extractJsonValue('Items [see below]: {"items": []}')).toEqual({ items: [] })
    expect(extractJsonValue('nothing here')).toBeNull()
  })
})
