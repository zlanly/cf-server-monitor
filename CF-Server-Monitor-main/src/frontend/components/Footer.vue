<template>
  <footer class="footer status-bar">
    <span>{{ VERSION }}</span>
    <span>Powered by <a href="https://github.com/huilang-me/CF-Server-Monitor" target="_blank">CF-Server-Monitor</a></span>
  </footer>
</template>

<script setup>
import { VERSION } from '../utils/api'
</script>