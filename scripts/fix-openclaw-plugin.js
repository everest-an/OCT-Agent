#!/usr/bin/env node

/**
 * OCT-Agent OpenClaw 插件修复脚本
 * 用于自动修复 openclaw-memory 插件找不到的问题
 */

import fs from 'fs';
import { execSync } from 'child_process';
import path from 'path';

console.log('🔧 OCT-Agent OpenClaw 插件修复工具');
console.log('');

try {
  // 检查 openclaw 命令是否存在
  console.log('🔍 检查 OpenClaw 安装...');
  execSync('which openclaw', { stdio: 'pipe' });
  console.log('✅ OpenClaw 已安装');
  
  // 检查当前插件状态
  console.log('');
  console.log('🔍 检查插件状态...');
  
  // 尝试修复配置
  console.log('');
  console.log('🔄 尝试修复 OpenClaw 配置...');
  try {
    const doctorResult = execSync('openclaw doctor --fix', { encoding: 'utf8', stdio: 'pipe' });
    console.log('✅ 配置修复完成');
  } catch (error) {
    // 如果 doctor --fix 失败，我们手动修复配置
    console.log('⚠️  配置修复时出现问题，正在手动处理...');
    
    // 获取配置文件路径
    const configFile = path.join(process.env.HOME, '.openclaw', 'openclaw.json');
    if (fs.existsSync(configFile)) {
      const config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
      
      // 移除有问题的插件引用
      if (config.plugins && config.plugins.slots && config.plugins.slots.memory === 'openclaw-memory') {
        delete config.plugins.slots.memory;
      }
      
      // 从 entries 中移除
      if (config.plugins && config.plugins.entries && config.plugins.entries['openclaw-memory']) {
        delete config.plugins.entries['openclaw-memory'];
      }
      
      // 从 allow 列表中移除
      if (config.plugins && config.plugins.allow) {
        config.plugins.allow = config.plugins.allow.filter(id => id !== 'openclaw-memory');
      }
      
      fs.writeFileSync(configFile, JSON.stringify(config, null, 2));
      console.log('✅ 手动配置清理完成');
    }
  }
  
  // 卸载旧插件（如果存在）
  console.log('');
  console.log('📦 卸载旧插件（如果存在）...');
  try {
    execSync('openclaw plugins uninstall openclaw-memory', { stdio: 'pipe' });
    console.log('✅ 旧插件已卸载');
  } catch (error) {
    // 插件可能不存在，忽略错误
    console.log('⚠️  插件可能未安装，继续...');
  }
  
  // 安装最新版本的插件
  console.log('');
  console.log('📥 安装最新版 Awareness Memory 插件...');
  console.log('⏳ 这可能需要几分钟时间，请耐心等待...');
  
  const installCmd = 'openclaw plugins install @awareness-sdk/openclaw-memory@latest --force --dangerously-force-unsafe-install';
  execSync(installCmd, { stdio: 'inherit' });
  
  console.log('');
  console.log('🔄 重启 OpenClaw 网关...');
  execSync('openclaw gateway restart', { stdio: 'inherit' });
  
  console.log('');
  console.log('🎉 修复完成！');
  console.log('');
  console.log('您的 Awareness Memory 插件现在应该可以正常工作了。');
  console.log('如果仍有问题，请重启 OCT-Agent 应用程序。');
  
} catch (error) {
  console.error('❌ 修复过程中出现错误:');
  console.error(error.message);
  
  console.log('');
  console.log('💡 手动解决方法:');
  console.log('1. 打开终端');
  console.log('2. 运行以下命令逐个执行:');
  console.log('   openclaw doctor --fix');
  console.log('   openclaw plugins uninstall openclaw-memory');
  console.log('   openclaw plugins install @awareness-sdk/openclaw-memory@latest --force --dangerously-force-unsafe-install');
  console.log('   openclaw gateway restart');
  console.log('');
  console.log('如果以上方法仍不能解决问题，请联系技术支持。');
}