import type { MileApi } from './index'

declare global {
  interface Window {
    mile: MileApi
  }
}
