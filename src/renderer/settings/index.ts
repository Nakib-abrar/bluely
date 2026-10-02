/**
 * Public surface of the settings slice. The main window renders these through its slots:
 * - <SettingsSheet open page onOpenChange onNavigate /> on 'settings:open' / header buttons,
 * - <Onboarding onDone /> while settings.general.onboardingComplete is false (route 'onboarding').
 */
export { SettingsSheet, type SettingsSheetProps } from './SettingsSheet'
export { Onboarding, type OnboardingProps } from './Onboarding'
