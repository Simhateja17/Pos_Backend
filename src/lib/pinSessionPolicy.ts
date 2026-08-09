import type { PinSwitchInput } from '../contracts/schemas/pin'

/** Only management authentication is meaningful before a browser is paired. */
export function pinSessionRequiresTerminal(sessionType: PinSwitchInput['sessionType']): boolean {
  return sessionType !== 'management'
}
