import React from 'react'
import { renderMopStats } from './mopRender.js'

// Раздел «Моя статистика» — вставка 1:1 HTML из монолита.
export default function MopStats({ data }) {
  return <div dangerouslySetInnerHTML={{ __html: renderMopStats(data) }} />
}
