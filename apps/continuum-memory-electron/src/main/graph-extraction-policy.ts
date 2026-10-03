export interface GraphExtractionSettings {
  extractionMode: 'rules' | 'uie' | 'open' | 'smart'
  graphExtractionEnabled: boolean
}

/** Remote open discovery is core output; the optional switch controls local supplements. */
export function shouldPersistGraphExtraction(settings: GraphExtractionSettings, source: 'remote' | 'local'): boolean {
  return source === 'remote'
    ? settings.extractionMode === 'open' || settings.extractionMode === 'smart'
    : settings.graphExtractionEnabled || settings.extractionMode === 'uie'
}

export function isGraphExtractionEnabled(settings: GraphExtractionSettings): boolean {
  return shouldPersistGraphExtraction(settings, 'remote') || shouldPersistGraphExtraction(settings, 'local')
}
