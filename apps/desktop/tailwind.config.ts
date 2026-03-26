import containerQueries from "@tailwindcss/container-queries";
import typography from "@tailwindcss/typography";
import type { Config } from "tailwindcss";
import type { PluginAPI } from "tailwindcss/types/config";
import tailwindcssAnimate from "tailwindcss-animate";
import baseUiConfig from "@chro/ui/tailwind.config";

const convertToRGB = (variableName: string) => `rgb(var(${variableName}))`;
const convertToRGBA = (variableName: string, alpha: number) =>
  `rgba(var(${variableName}), ${alpha})`;

const config: Config = {
  presets: [baseUiConfig as Config],
  content: [
    "./src/**/*.{js,ts,jsx,tsx,mdx}",
    "../../packages/ui/src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      fontFamily: {
        sans: ["var(--font-inter)", "Inter", "system-ui", "sans-serif"],
      },
      fontSize: {
        "1.5xl": ["1.375rem", { lineHeight: "1.875rem" }],
        "2.5xl": ["1.75rem", { lineHeight: "2.25rem" }],
      },
      boxShadow: {
        "custom-shadow": "var(--color-shadow-custom)",
        "custom-shadow-2xs": "var(--color-shadow-2xs)",
        "custom-shadow-xs": "var(--color-shadow-xs)",
        "custom-shadow-sm": "var(--color-shadow-sm)",
        "custom-shadow-rg": "var(--color-shadow-rg)",
        "custom-shadow-md": "var(--color-shadow-md)",
        "custom-shadow-lg": "var(--color-shadow-lg)",
        "custom-shadow-xl": "var(--color-shadow-xl)",
        "custom-shadow-2xl": "var(--color-shadow-2xl)",
        "custom-shadow-3xl": "var(--color-shadow-3xl)",
        "custom-shadow-4xl": "var(--color-shadow-4xl)",
        "custom-sidebar-shadow-2xs": "var(--color-sidebar-shadow-2xs)",
        "custom-sidebar-shadow-xs": "var(--color-sidebar-shadow-xs)",
        "custom-sidebar-shadow-sm": "var(--color-sidebar-shadow-sm)",
        "custom-sidebar-shadow-rg": "var(--color-sidebar-shadow-rg)",
        "custom-sidebar-shadow-md": "var(--color-sidebar-shadow-md)",
        "custom-sidebar-shadow-lg": "var(--color-sidebar-shadow-lg)",
        "custom-sidebar-shadow-xl": "var(--color-sidebar-shadow-xl)",
        "custom-sidebar-shadow-2xl": "var(--color-sidebar-shadow-2xl)",
        "custom-sidebar-shadow-3xl": "var(--color-sidebar-shadow-3xl)",
        "custom-sidebar-shadow-4xl": "var(--color-sidebar-shadow-4xl)",
      },
      colors: {
        custom: {
          primary: {
            0: "rgb(255, 255, 255)",
            10: convertToRGB("--color-primary-10"),
            20: convertToRGB("--color-primary-20"),
            30: convertToRGB("--color-primary-30"),
            40: convertToRGB("--color-primary-40"),
            50: convertToRGB("--color-primary-50"),
            60: convertToRGB("--color-primary-60"),
            70: convertToRGB("--color-primary-70"),
            80: convertToRGB("--color-primary-80"),
            90: convertToRGB("--color-primary-90"),
            100: convertToRGB("--color-primary-100"),
            200: convertToRGB("--color-primary-200"),
            300: convertToRGB("--color-primary-300"),
            400: convertToRGB("--color-primary-400"),
            500: convertToRGB("--color-primary-500"),
            600: convertToRGB("--color-primary-600"),
            700: convertToRGB("--color-primary-700"),
            800: convertToRGB("--color-primary-800"),
            900: convertToRGB("--color-primary-900"),
            1000: "rgb(0, 0, 0)",
            DEFAULT: convertToRGB("--color-primary-100"),
          },
          background: {
            0: "rgb(255, 255, 255)",
            10: convertToRGB("--color-background-10"),
            20: convertToRGB("--color-background-20"),
            30: convertToRGB("--color-background-30"),
            40: convertToRGB("--color-background-40"),
            50: convertToRGB("--color-background-50"),
            60: convertToRGB("--color-background-60"),
            70: convertToRGB("--color-background-70"),
            80: convertToRGB("--color-background-80"),
            90: convertToRGB("--color-background-90"),
            100: convertToRGB("--color-background-100"),
            200: convertToRGB("--color-background-200"),
            300: convertToRGB("--color-background-300"),
            400: convertToRGB("--color-background-400"),
            500: convertToRGB("--color-background-500"),
            600: convertToRGB("--color-background-600"),
            700: convertToRGB("--color-background-700"),
            800: convertToRGB("--color-background-800"),
            900: convertToRGB("--color-background-900"),
            1000: "rgb(0, 0, 0)",
            overlay: convertToRGBA("--color-background-80", 0.95),
            primary: convertToRGB(" --color-background-primary"),
            error: convertToRGB(" --color-background-error"),
            DEFAULT: convertToRGB("--color-background-100"),
          },
          text: {
            0: "rgb(255, 255, 255)",
            10: convertToRGB("--color-text-10"),
            20: convertToRGB("--color-text-20"),
            30: convertToRGB("--color-text-30"),
            40: convertToRGB("--color-text-40"),
            50: convertToRGB("--color-text-50"),
            60: convertToRGB("--color-text-60"),
            70: convertToRGB("--color-text-70"),
            80: convertToRGB("--color-text-80"),
            90: convertToRGB("--color-text-90"),
            100: convertToRGB("--color-text-100"),
            200: convertToRGB("--color-text-200"),
            300: convertToRGB("--color-text-300"),
            350: convertToRGB("--color-text-350"),
            400: convertToRGB("--color-text-400"),
            500: convertToRGB("--color-text-500"),
            600: convertToRGB("--color-text-600"),
            700: convertToRGB("--color-text-700"),
            800: convertToRGB("--color-text-800"),
            900: convertToRGB("--color-text-900"),
            1000: "rgb(0, 0, 0)",
            primary: convertToRGB("--color-text-primary"),
            error: convertToRGB("--color-text-error"),
            DEFAULT: convertToRGB("--color-text-100"),
          },
          border: {
            0: "rgb(255, 255, 255)",
            100: convertToRGB("--color-border-100"),
            200: convertToRGB("--color-border-200"),
            300: convertToRGB("--color-border-300"),
            400: convertToRGB("--color-border-400"),
            1000: "rgb(0, 0, 0)",
            primary: convertToRGB("--color-border-primary"),
            error: convertToRGB("--color-border-error"),
            DEFAULT: convertToRGB("--color-border-200"),
          },
          backdrop: "rgba(0, 0, 0, 0.25)",
          error: {
            10: convertToRGB("--color-error-10"),
            20: convertToRGB("--color-error-20"),
            30: convertToRGB("--color-error-30"),
            100: convertToRGB("--color-error-100"),
            200: convertToRGB("--color-error-200"),
            500: convertToRGB("--color-error-500"),
          },
          sidebar: {
            background: {
              0: "rgb(255, 255, 255)",
              10: convertToRGB("--color-sidebar-background-10"),
              20: convertToRGB("--color-sidebar-background-20"),
              30: convertToRGB("--color-sidebar-background-30"),
              40: convertToRGB("--color-sidebar-background-40"),
              50: convertToRGB("--color-sidebar-background-50"),
              60: convertToRGB("--color-sidebar-background-60"),
              70: convertToRGB("--color-sidebar-background-70"),
              80: convertToRGB("--color-sidebar-background-80"),
              90: convertToRGB("--color-sidebar-background-90"),
              100: convertToRGB("--color-sidebar-background-100"),
              200: convertToRGB("--color-sidebar-background-200"),
              300: convertToRGB("--color-sidebar-background-300"),
              400: convertToRGB("--color-sidebar-background-400"),
              500: convertToRGB("--color-sidebar-background-500"),
              600: convertToRGB("--color-sidebar-background-600"),
              700: convertToRGB("--color-sidebar-background-700"),
              800: convertToRGB("--color-sidebar-background-800"),
              900: convertToRGB("--color-sidebar-background-900"),
              1000: "rgb(0, 0, 0)",
              DEFAULT: convertToRGB("--color-sidebar-background-100"),
            },
            text: {
              0: "rgb(255, 255, 255)",
              10: convertToRGB("--color-sidebar-text-10"),
              20: convertToRGB("--color-sidebar-text-20"),
              30: convertToRGB("--color-sidebar-text-30"),
              40: convertToRGB("--color-sidebar-text-40"),
              50: convertToRGB("--color-sidebar-text-50"),
              60: convertToRGB("--color-sidebar-text-60"),
              70: convertToRGB("--color-sidebar-text-70"),
              80: convertToRGB("--color-sidebar-text-80"),
              90: convertToRGB("--color-sidebar-text-90"),
              100: convertToRGB("--color-sidebar-text-100"),
              200: convertToRGB("--color-sidebar-text-200"),
              300: convertToRGB("--color-sidebar-text-300"),
              400: convertToRGB("--color-sidebar-text-400"),
              500: convertToRGB("--color-sidebar-text-500"),
              600: convertToRGB("--color-sidebar-text-600"),
              700: convertToRGB("--color-sidebar-text-700"),
              800: convertToRGB("--color-sidebar-text-800"),
              900: convertToRGB("--color-sidebar-text-900"),
              1000: "rgb(0, 0, 0)",
              DEFAULT: convertToRGB("--color-sidebar-text-100"),
            },
            border: {
              0: "rgb(255, 255, 255)",
              100: convertToRGB("--color-sidebar-border-100"),
              200: convertToRGB("--color-sidebar-border-200"),
              300: convertToRGB("--color-sidebar-border-300"),
              400: convertToRGB("--color-sidebar-border-400"),
              1000: "rgb(0, 0, 0)",
              DEFAULT: convertToRGB("--color-sidebar-border-200"),
            },
          },
        },
      },
    },
  },
  plugins: [
    tailwindcssAnimate,
    typography,
    containerQueries,
    ({ addUtilities, addComponents }: PluginAPI) => {
      const newUtilities: Parameters<PluginAPI["addUtilities"]>[0] = {
        ".px-page-x": {
          paddingLeft: "1.25rem",
          paddingRight: "1.25rem",
        },
        "@media (min-width: 768px)": {
          ".px-page-x": {
            paddingLeft: "1.35rem",
            paddingRight: "1.35rem",
          },
        },
        ".scrollbar-hide": {
          "-ms-overflow-style": "none",
          "scrollbar-width": "none",
          "&::-webkit-scrollbar": {
            display: "none",
          },
        },
        ".vertical-scrollbar": {
          overflowY: "auto",
        },
        ".horizontal-scrollbar": {
          overflowX: "auto",
        },
        ".vertical-scrollbar::-webkit-scrollbar, .horizontal-scrollbar::-webkit-scrollbar":
          {
            display: "block",
          },
        ".vertical-scrollbar::-webkit-scrollbar-track, .horizontal-scrollbar::-webkit-scrollbar-track":
          {
            backgroundColor: "transparent",
            borderRadius: "9999px",
          },
        ".vertical-scrollbar::-webkit-scrollbar-thumb, .horizontal-scrollbar::-webkit-scrollbar-thumb":
          {
            backgroundClip: "padding-box",
            backgroundColor: "rgba(96, 100, 108, 0.1)",
            borderRadius: "9999px",
          },
        ".vertical-scrollbar:hover::-webkit-scrollbar-thumb, .horizontal-scrollbar:hover::-webkit-scrollbar-thumb":
          {
            backgroundColor: "rgba(96, 100, 108, 0.25)",
          },
        ".vertical-scrollbar::-webkit-scrollbar-thumb:hover, .horizontal-scrollbar::-webkit-scrollbar-thumb:hover":
          {
            backgroundColor: "rgba(96, 100, 108, 0.5)",
          },
        ".vertical-scrollbar::-webkit-scrollbar-thumb:active, .horizontal-scrollbar::-webkit-scrollbar-thumb:active":
          {
            backgroundColor: "rgba(96, 100, 108, 0.7)",
          },
        ".vertical-scrollbar::-webkit-scrollbar-corner, .horizontal-scrollbar::-webkit-scrollbar-corner":
          {
            backgroundColor: "transparent",
          },
        ".scrollbar-sm::-webkit-scrollbar": {
          height: "12px",
          width: "12px",
        },
        ".scrollbar-sm::-webkit-scrollbar-thumb": {
          border: "3px solid rgba(0, 0, 0, 0)",
        },
        ".scrollbar-md::-webkit-scrollbar": {
          height: "14px",
          width: "14px",
        },
        ".scrollbar-md::-webkit-scrollbar-thumb": {
          border: "3px solid rgba(0, 0, 0, 0)",
        },
        ".scrollbar-lg::-webkit-scrollbar": {
          height: "16px",
          width: "16px",
        },
        ".scrollbar-lg::-webkit-scrollbar-thumb": {
          border: "4px solid rgba(0, 0, 0, 0)",
        },
        ".highlight": {
          borderColor: "rgb(var(--color-primary-100)) !important",
          borderStyle: "solid !important",
          borderWidth: "1px !important",
        },
        ".highlight-with-line": {
          backgroundColor: "rgb(var(--color-background-80))",
          borderLeftColor: "rgb(var(--color-primary-100)) !important",
          borderLeftStyle: "solid !important",
          borderLeftWidth: "5px !important",
        },
      };

      const scrollbarThumbDefault = "rgba(96, 100, 108, 0.1)";
      const scrollbarThumbHover = "rgba(96, 100, 108, 0.25)";
      const scrollbarThumbHoverStrong = "rgba(96, 100, 108, 0.5)";
      const scrollbarThumbActive = "rgba(96, 100, 108, 0.7)";

      type ComponentStyles = Parameters<PluginAPI["addComponents"]>[0];
      type ScrollbarStyles = Record<string, string | Record<string, string>>;

      const buildScrollbarAxis = (): ScrollbarStyles => ({
        "scrollbar-width": "initial",
        "scrollbar-color": `${scrollbarThumbDefault} transparent`,
        "&::-webkit-scrollbar": {
          display: "block",
        },
        "&::-webkit-scrollbar-track": {
          backgroundColor: "transparent",
          borderRadius: "9999px",
        },
        "&::-webkit-scrollbar-thumb": {
          backgroundClip: "padding-box",
          backgroundColor: scrollbarThumbDefault,
          borderRadius: "9999px",
        },
        "&:hover::-webkit-scrollbar-thumb": {
          backgroundColor: scrollbarThumbHover,
        },
        "&::-webkit-scrollbar-thumb:hover": {
          backgroundColor: scrollbarThumbHoverStrong,
        },
        "&::-webkit-scrollbar-thumb:active": {
          backgroundColor: scrollbarThumbActive,
        },
        "&::-webkit-scrollbar-corner": {
          backgroundColor: "transparent",
        },
      });

      const scrollbarComponents: ComponentStyles = {
        ".vertical-scrollbar": buildScrollbarAxis(),
        ".horizontal-scrollbar": buildScrollbarAxis(),
        ".scrollbar-sm": {
          "&::-webkit-scrollbar": {
            height: "12px",
            width: "12px",
          },
          "&::-webkit-scrollbar-thumb": {
            border: "3px solid transparent",
          },
        },
        ".scrollbar-md": {
          "&::-webkit-scrollbar": {
            height: "14px",
            width: "14px",
          },
          "&::-webkit-scrollbar-thumb": {
            border: "3px solid transparent",
          },
        },
        ".scrollbar-lg": {
          "&::-webkit-scrollbar": {
            height: "16px",
            width: "16px",
          },
          "&::-webkit-scrollbar-thumb": {
            border: "4px solid transparent",
          },
        },
      };

      addUtilities(newUtilities);
      addComponents(scrollbarComponents);
    },
  ],
};

export default config;
