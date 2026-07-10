import React from 'react'
import { renderMopTeam } from './mopRender.js'

// Раздел «Команда» — вставка 1:1 HTML из монолита.
export default function MopTeam({ data }) {
  return <div dangerouslySetInnerHTML={{ __html: renderMopTeam(data) }} />
}
