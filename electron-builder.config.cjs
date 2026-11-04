/**
 * electron-builder configuration for GitGrove.
 *
 * Linux   : AppImage, deb, rpm, pacman, tar.gz, snap (Flatpak via scripts/build-flatpak.sh)
 * Windows : NSIS installer, portable exe, zip
 * macOS   : dmg, zip   (x64 and arm64)
 *
 * Architecture is selected on the command line so CI can build each target on a
 * matching runner:  npx electron-builder --linux --arm64
 */
module.exports = {
  appId: 'dev.gitgrove.GitGrove',
  productName: 'GitGrove',
  copyright: 'Copyright © 2026 GitGrove Contributors',
  artifactName: '${productName}-${version}-${os}-${arch}.${ext}',
  directories: {
    buildResources: 'build',
    output: 'dist'
  },
  files: [
    'out/**/*',
    'package.json',
    '!**/*.map',
    '!**/{.eslintrc,.editorconfig,.prettierrc,tsconfig*.json,vitest.config.ts,electron.vite.config.ts,electron-builder.config.cjs}'
  ],
  extraMetadata: {
    main: './out/main/index.js'
  },
  asar: true,
  asarUnpack: ['**/*.node'],
  compression: 'maximum',
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
      name: 'GitGrove',
      schemes: ['gitgrove']
    }
  ],

  linux: {
    target: [
      { target: 'AppImage', arch: ['x64', 'arm64'] },
      { target: 'deb', arch: ['x64', 'arm64'] },
      { target: 'rpm', arch: ['x64', 'arm64'] },
      { target: 'pacman', arch: ['x64', 'arm64'] },
      { target: 'tar.gz', arch: ['x64', 'arm64'] },
      { target: 'snap', arch: ['x64', 'arm64'] }
    ],
    category: 'Development;RevisionControl',
    icon: 'build/icons',
    executableName: 'gitgrove',
    maintainer: 'GitGrove Contributors <hello@gitgrove.dev>',
    vendor: 'GitGrove',
    synopsis: 'A focused desktop Git client',
    description:
      'GitGrove is a fast desktop Git client built on system Git. It manages repositories, branches, worktrees, tags, releases and pipelines, with multi-account identity support for GitHub, GitLab, Bitbucket and Gitea.',
    desktop: {
      entry: {
        Name: 'GitGrove',
        GenericName: 'Git Client',
        Comment: 'Manage repositories, branches, worktrees, releases and pipelines',
        Keywords: 'git;scm;version control;repository;branch;worktree;',
        Categories: 'Development;RevisionControl;',
        StartupWMClass: 'GitGrove',
        MimeType: 'x-scheme-handler/gitgrove;'
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
      GITGROVE_GIT: '/usr/bin/git'
    }
  },

  win: {
    target: [
      { target: 'nsis', arch: ['x64', 'arm64'] },
      { target: 'portable', arch: ['x64', 'arm64'] },
      { target: 'zip', arch: ['x64', 'arm64'] }
    ],
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
    shortcutName: 'GitGrove',
    uninstallDisplayName: 'GitGrove',
    deleteAppDataOnUninstall: false,
    include: 'build/installer.nsh',
    artifactName: '${productName}-${version}-${arch}-setup.${ext}'
  },

  portable: {
    artifactName: '${productName}-${version}-${arch}-portable.${ext}'
  },

  mac: {
    target: [
      { target: 'dmg', arch: ['x64', 'arm64'] },
      { target: 'zip', arch: ['x64', 'arm64'] }
    ],
    category: 'public.app-category.developer-tools',
    icon: 'build/icon.icns',
    hardenedRuntime: true,
    gatekeeperAssess: false,
    darkModeSupport: true,
    entitlements: 'build/entitlements.mac.plist',
    entitlementsInherit: 'build/entitlements.mac.plist',
    extendInfo: {
      NSDocumentsFolderUsageDescription: 'GitGrove needs access to repositories you choose to open.',
      NSDownloadsFolderUsageDescription: 'GitGrove needs access to repositories you choose to clone.',
      NSDesktopFolderUsageDescription: 'GitGrove needs access to repositories you choose to open.'
    },
    artifactName: '${productName}-${version}-${arch}.${ext}'
  },

  dmg: {
    title: 'GitGrove ${version}',
    contents: [
      { x: 140, y: 200, type: 'file' },
      { x: 400, y: 200, type: 'link', path: '/Applications' }
    ]
  },

  publish: [
    {
      provider: 'github',
      owner: 'gitgrove',
      repo: 'gitgrove',
      releaseType: 'draft'
    }
  ]
}