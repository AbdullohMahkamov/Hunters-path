import React from 'react'
import { renderMopEarnings } from './mopRender.js'

// Раздел «Мой заработок» — вставка 1:1 HTML из монолита.
export default function MopEarnings({ data }) {
  return <div dangerouslySetInnerHTML={{ __html: renderMopEarnings(data) }} />
}
