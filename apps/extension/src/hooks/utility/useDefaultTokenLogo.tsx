import { ThemeName, useTheme } from '@leapwallet/leap-ui'
import { useMemo } from 'react'

import { Images } from '../../images'

export function getDefaultTokenLogo(darkTheme: boolean) {
  const defaultLogo = darkTheme ? Images.Logos.GenericDark : Images.Logos.GenericDark
  return defaultLogo
}

export function useDefaultTokenLogo() {
  const darkTheme = useTheme().theme === ThemeName.DARK
  return useMemo(() => {
    return getDefaultTokenLogo(darkTheme)
  }, [darkTheme])
}
