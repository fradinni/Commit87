/**
 * electron-builder configuration for Commit87.
 *
 * Linux   : AppImage, deb, rpm, pacman, tar.gz, snap (Flatpak via scripts/build-flatpak.sh)
 * Windows : NSIS installer, portable exe, zip
 * macOS   : dmg, zip   (x64 and arm64)
 *
 * Architecture is selected on the command line so CI can build each target on a
 * matching runner:  npx electron-builder --linux --arm64
 */
const { existsSync } = require('node:fs')
const { resolve } = require('node:path')

// electron-builder packages whatever is already in `out/`; it does not build the
// app. Fail early with a clear message instead of producing a broken ASAR that
// only reports the missing entry file after packaging.
const mainEntry = resolve(__dirname, 'out/main/index.js')
if (!existsSync(mainEntry)) {
  throw new Error(
    `Missing ${mainEntry}. Run "npm run build" before invoking electron-builder ` +
      '(or use "npm run build:linux", "npm run build:win", "npm run build:mac" or "npm run pack:dir").'
  )
}

module.exports = {
  appId: 'fr.fradinni.Commit87',
  productName: 'Commit87',
  copyright: 'Copyright © 2026 Commit87 Contributors',
  artifactName: '${productName}-${version}-${os}-${arch}.${ext}',
  directories: {
    buildResources: 'build',
    output: 'dist'
  },
  files: [
    'out/**/*',
    'package.json',
    // Renderer, preload and main are fully bundled by electron-vite, so the
    // production dependencies are not needed at runtime. Excluding node_modules
    // keeps the ASAR (and AppImage cold start) much smaller.
    '!node_modules/**/*',
    '!**/*.map',
    '!**/{.eslintrc,.editorconfig,.prettierrc,tsconfig*.json,vitest.config.ts,electron.vite.config.ts,electron-builder.config.cjs}'
  ],
  extraMetadata: {
    main: './out/main/index.js'
  },
  asar: true,
  asarUnpack: ['**/*.node'],
  // AppImage reads files straight out of the squashfs image. "maximum" uses xz
  // and adds seconds of decompression to every cold start, so prefer gzip.
  compression: 'normal',
  removePackageScripts: true,
  npmRebuild: false,
  electronFuses: {
    runAsNode: false,
    enableCookieEncryption: true,
    enableNodeOptionsEnvironmentVariable: false,
    enableNodeCliInspectArguments: false,
    enableEmbeddedAsarIntegrityValidation: true,
    onlyLoadAppFromAsar: true,
    loadBrowserProcessSpecificV8Snapshot: false,
    grantFileProtocolExtraPrivileges: false
  },
  protocols: [
    {
      name: 'Commit87',
      schemes: ['commit87']
    }
  ],

  linux: {
    // Architectures come from the command line (`--x64`, `--arm64`, or both).
    // Listing them here would override a single-arch CI build and produce both.
    target: ['AppImage', 'deb', 'rpm', 'pacman', 'tar.gz'],
    category: 'Development;RevisionControl',
    icon: 'build/icons',
    executableName: 'commit87',
    maintainer: 'Commit87 Contributors <contact@fradinni.fr>',
    vendor: 'Commit87',
    synopsis: 'A focused desktop Git client',
    description:
      'Commit87 is a fast desktop Git client built on system Git. It manages repositories, branches, worktrees, tags, releases and pipelines, with multi-account identity support for GitHub, GitLab, Bitbucket and Gitea.',
    desktop: {
      entry: {
        Name: 'Commit87',
        GenericName: 'Git Client',
        Comment: 'Manage repositories, branches, worktrees, releases and pipelines',
        Keywords: 'git;scm;version control;repository;branch;worktree;',
        Categories: 'Development;RevisionControl;',
        StartupWMClass: 'Commit87',
        MimeType: 'x-scheme-handler/commit87;'
      }
    }
  },

  deb: {
    depends: ['git', 'libgtk-3-0', 'libnotify4', 'libnss3', 'libxss1', 'libxtst6', 'xdg-utils', 'libatspi2.0-0', 'libsecret-1-0']
  },

  rpm: {
    depends: ['git', 'gtk3', 'libnotify', 'nss', 'libXScrnSaver', 'libXtst', 'xdg-utils', 'at-spi2-core', 'libsecret']
  },

  pacman: {
    depends: ['git', 'gtk3', 'libnotify', 'nss', 'libxss', 'libxtst', 'xdg-utils', 'at-spi2-core', 'libsecret']
  },

  appImage: {
    artifactName: '${productName}-${version}-linux-${arch}.${ext}'
  },

  snap: {
    grade: 'stable',
    confinement: 'strict',
    summary: 'Focused desktop Git client',
    plugs: ['default', 'home', 'removable-media', 'password-manager-service', 'ssh-keys'],
    environment: {
      COMMIT87_GIT: '/usr/bin/git'
    }
  },

  win: {
    target: ['nsis', 'portable', 'zip'],
    icon: 'build/icon.ico',
    requestedExecutionLevel: 'asInvoker',
    artifactName: '${productName}-${version}-${arch}.${ext}'
  },

  nsis: {
    oneClick: false,
    perMachine: false,
    allowElevation: true,
    allowToChangeInstallationDirectory: true,
    createDesktopShortcut: true,
    createStartMenuShortcut: true,
    shortcutName: 'Commit87',
    uninstallDisplayName: 'Commit87',
    deleteAppDataOnUninstall: false,
    include: 'build/installer.nsh',
    artifactName: '${productName}-${version}-${arch}-setup.${ext}'
  },

  portable: {
    artifactName: '${productName}-${version}-${arch}-portable.${ext}'
  },

  mac: {
    target: ['dmg', 'pkg', 'zip'],
    category: 'public.app-category.developer-tools',
    icon: 'build/icon.icns',
    hardenedRuntime: true,
    gatekeeperAssess: false,
    darkModeSupport: true,
    entitlements: 'build/entitlements.mac.plist',
    entitlementsInherit: 'build/entitlements.mac.plist',
    extendInfo: {
      NSDocumentsFolderUsageDescription: 'Commit87 needs access to repositories you choose to open.',
      NSDownloadsFolderUsageDescription: 'Commit87 needs access to repositories you choose to clone.',
      NSDesktopFolderUsageDescription: 'Commit87 needs access to repositories you choose to open.'
    },
    artifactName: '${productName}-${version}-${arch}.${ext}'
  },

  dmg: {
    title: 'Commit87 ${version}',
    contents: [
      { x: 140, y: 200, type: 'file' },
      { x: 400, y: 200, type: 'link', path: '/Applications' }
    ]
  },

  publish: [
    {
      provider: 'github',
      owner: 'fradinni',
      repo: 'Commit87',
      // Pre-release tags (v1.2.0-beta.1) publish beta.yml and are marked as a
      // GitHub pre-release, so /releases/latest keeps pointing at the last
      // stable release. Stable tags stay drafts until a maintainer publishes.
      releaseType: process.env.COMMIT87_RELEASE_CHANNEL === 'beta' ? 'prerelease' : 'draft',
      // The release workflow sets COMMIT87_RELEASE_CHANNEL from the tag.
      channel: process.env.COMMIT87_RELEASE_CHANNEL === 'beta' ? 'beta' : 'latest'
    }
  ]
}