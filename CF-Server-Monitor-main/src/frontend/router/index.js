import { createRouter, createWebHashHistory } from 'vue-router'

const routes = [
  {
    path: '/',
    name: 'Dashboard',
    component: () => import('../views/Dashboard.vue')
  },
  {
    path: '/admin',
    name: 'Admin',
    component: () => import('../views/Admin.vue')
  },
  {
    path: '/server/:id',
    name: 'Server',
    component: () => import('../views/ServerDetail.vue')
  },
  {
    path: '/ssh/:id',
    name: 'SSH',
    component: () => import('../views/SSHTerminal.vue'),
    // 把路由参数 id 映射为 SSHTerminal.vue 期望的 serverId prop，否则组件内 serverId 为 undefined
    props: (route) => ({ serverId: route.params.id })
  }
]

const router = createRouter({
  history: createWebHashHistory(),
  routes
})

export default router