---
layout: home

hero:
  name: "ts-git-lfs"
  text: "Git Large File Storage, in TypeScript"
  tagline: "Pointer files, the batch API, an object store and file locking - as four separable pieces."
  actions:
    - theme: brand
      text: Get Started
      link: /intro
    - theme: alt
      text: View on GitHub
      link: https://github.com/stacksjs/ts-git-lfs

features:
  - title: "Pointer files"
    icon: "📄"
    details: "Read and write the format git actually hashes, strictly enough that the same file always produces the same blob."
  - title: "The batch API"
    icon: "📦"
    details: "One request asks about a hundred objects. The decisions are pure functions you can test without a socket."
  - title: "Content-addressed storage"
    icon: "🔒"
    details: "Bytes are verified against their hash before they are stored, and streamed on the way out."
  - title: "File locking"
    icon: "🔑"
    details: "A binary file cannot be merged, so two people editing one is not a conflict - it is somebody losing work."
---
