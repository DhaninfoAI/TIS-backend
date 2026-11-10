// The web tools SmartFill works in. Each customer organisation has one (org.platform); the extension reads it at
// sign-in and uses that platform's page code, the backend its prompts and rules.
// To add a platform: add it here, then its page code in the extension (detect / read / write) and its rules.
export const PLATFORMS = {
  ez: { id: 'ez', name: 'EZSurveyForm', site: 'ezsurveyform.com' },
};
export const DEFAULT_PLATFORM = 'ez';
