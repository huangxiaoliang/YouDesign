declare const navigationCore: {
  introducedPrototypeNavigation(before: string, after: string): string[];
  prototypeNavigationFindings(code: string): Array<{ label: string; index: number; match: string }>;
  unsafePrototypeNavigation(code: string): string[];
};

export = navigationCore;
