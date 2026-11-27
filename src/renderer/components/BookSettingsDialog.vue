<script setup lang="ts">
import { computed, ref } from 'vue';
import type { Book, GenreTemplate } from '../../shared/ipc-contract.js';
import { listSep, t } from '../i18n/index.js';

const props = defineProps<{
  book: Book;
  genres: GenreTemplate[];
}>();

const emit = defineEmits<{
  close: [];
  refresh: [];
  flash: [message: string];
  deleted: [];
}>();

const title = ref(props.book.title);
const outline = ref(props.book.outline);
const genreId = ref(props.book.genreId ?? '');
const busy = ref(false);
const aiBusy = ref(false);

const currentGenre = computed(() => props.genres.find((genre) => genre.id === props.book.genreId) ?? null);

/** 把侧重配置翻译成人话，作者才知道选了题材会带来什么后果 */
const profileSummary = computed(() => {
  const genre = props.genres.find((item) => item.id === genreId.value);
  if (!genre) return '';
  const levelName: Record<string, string> = {
    strict: t('阻断定稿'),
    relaxed: t('降为提示'),
    off: t('不再检查'),
  };
  const ruleName: Record<string, string> = {
    wordCount: t('字数实测'),
    foreshadowPayoff: t('伏笔执行率'),
    hookRotation: t('钩子轮换'),
    repetition: t('重复用语'),
    aiTone: t('AI 痕迹'),
    characterConsistency: t('人物一致性'),
    logic: t('逻辑合理性'),
    style: t('文风自然度'),
    emotionArc: t('情感弧线'),
  };
  const parts = [
    ...Object.entries(genre.profile.gate ?? {}).map(
      ([rule, level]) =>
        t('门禁 {rule} → {level}', {
          rule: ruleName[rule] ?? rule,
          level: levelName[level ?? 'normal'] ?? String(level ?? ''),
        }),
    ),
    ...Object.entries(genre.profile.audit ?? {}).map(
      ([rule, level]) =>
        t('审计 {rule} → {level}', {
          rule: ruleName[rule] ?? rule,
          level: levelName[level ?? 'normal'] ?? String(level ?? ''),
        }),
    ),
  ];
  return parts.join(listSep());
});

async function save(): Promise<void> {
  if (!title.value.trim()) return emit('flash', t('作品名称不能为空'));
  busy.value = true;
  try {
    const res = await window.api.updateBook({
      bookId: props.book.id,
      title: title.value.trim(),
      outline: outline.value,
    });
    if (!res.ok) throw new Error(res.error ?? t('保存失败'));
    emit('flash', t('作品信息已保存'));
    emit('refresh');
  } catch (error) {
    emit('flash', error instanceof Error ? error.message : String(error));
  } finally {
    busy.value = false;
  }
}

async function suggestOutline(): Promise<void> {
  aiBusy.value = true;
  try {
    const res = await window.api.suggestOutline({ bookId: props.book.id });
    if (!res.ok || !res.data) throw new Error(res.error ?? t('生成大纲失败'));
    outline.value = res.data.outline;
    emit('flash', t('已生成卷纲建议（{model}），确认后再保存', { model: res.data.model }));
  } catch (error) {
    emit('flash', error instanceof Error ? error.message : String(error));
  } finally {
    aiBusy.value = false;
  }
}

async function applyGenre(): Promise<void> {
  if (!genreId.value) return;
  busy.value = true;
  try {
    const res = await window.api.applyGenre({ bookId: props.book.id, genreId: genreId.value });
    if (!res.ok || !res.data) throw new Error(res.error ?? t('应用题材失败'));
    emit(
      'flash',
      t('已切换题材为「{name}」，补写 {n} 条世界规则，门禁与审计侧重已生效', {
        name: t(res.data.genre.name),
        n: res.data.createdRules,
      }),
    );
    emit('refresh');
  } catch (error) {
    emit('flash', error instanceof Error ? error.message : String(error));
  } finally {
    busy.value = false;
  }
}

/** 清除题材：世界规则保留（它们是作者资产），只把门禁/审计侧重恢复为默认 */
async function clearGenre(): Promise<void> {
  busy.value = true;
  try {
    const res = await window.api.updateBook({ bookId: props.book.id, genreId: null });
    if (!res.ok) throw new Error(res.error ?? t('清除题材失败'));
    genreId.value = '';
    emit('flash', t('已清除题材，门禁与审计恢复默认严格度（已写入的世界规则保留）'));
    emit('refresh');
  } catch (error) {
    emit('flash', error instanceof Error ? error.message : String(error));
  } finally {
    busy.value = false;
  }
}

async function removeBook(): Promise<void> {
  const ok = window.confirm(
    t('删除作品《{title}》？\n\n这会删除全部章节、事实源、快照与检索索引，且无法恢复。', {
      title: props.book.title,
    }),
  );
  if (!ok) return;
  busy.value = true;
  try {
    const res = await window.api.deleteBook({ bookId: props.book.id });
    if (!res.ok) throw new Error(res.error ?? t('删除失败'));
    emit('deleted');
  } catch (error) {
    emit('flash', error instanceof Error ? error.message : String(error));
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div class="modal-backdrop" @click.self="emit('close')">
    <div class="dialog">
      <div class="dialog-head">
        <h3>{{ t('作品设置') }}</h3>
        <button @click="emit('close')">{{ t('关闭') }}</button>
      </div>

      <label>{{ t('作品名称') }}</label>
      <input v-model="title" :placeholder="t('作品名称')" />

      <label>{{ t('作品总纲') }}</label>
      <textarea v-model="outline" rows="10" :placeholder="t('主线、卷结构、核心冲突、结局方向…')"></textarea>
      <div class="outline-actions">
        <button :disabled="aiBusy" @click="suggestOutline">
          {{ aiBusy ? t('生成中…') : t('AI 生成卷纲建议') }}
        </button>
        <span class="hint">{{ t('生成结果只填入文本框，需你确认后保存') }}</span>
      </div>

      <label>
        {{ t('题材规则集') }}
        <span v-if="currentGenre" class="badge info">
          {{ t('当前：{name}', { name: t(currentGenre.name) }) }}
        </span>
      </label>
      <div class="genre-row">
        <select v-model="genreId">
          <option value="">{{ t('选择题材（可选）') }}</option>
          <option v-for="genre in genres" :key="genre.id" :value="genre.id">
            {{ t(genre.name) }} · {{ t(genre.description) }}
          </option>
        </select>
        <button :disabled="busy || !genreId || genreId === book.genreId" @click="applyGenre">
          {{ t('应用题材') }}
        </button>
        <button v-if="book.genreId" :disabled="busy" @click="clearGenre">{{ t('清除') }}</button>
      </div>
      <p v-if="profileSummary" class="hint">{{ t('侧重：{summary}', { summary: profileSummary }) }}</p>
      <p class="hint">
        {{
          t(
            '题材决定门禁与审计的松紧（例如悬疑把「伏笔逾期」提到阻断级、玄幻把「能力越界」提到阻断级），并补写对应世界规则。只补充不覆盖，可重复应用。',
          )
        }}
      </p>

      <div class="dialog-actions">
        <button class="danger" :disabled="busy" @click="removeBook">{{ t('删除作品') }}</button>
        <div class="spacer"></div>
        <button @click="emit('close')">{{ t('取消') }}</button>
        <button class="primary" :disabled="busy" @click="save">{{ t('保存') }}</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.modal-backdrop { position: fixed; inset: 0; background: rgba(16,24,40,.45); display: flex; align-items: center; justify-content: center; z-index: 120; }
.dialog { background: #fff; border-radius: 10px; padding: 22px; width: 640px; max-height: 86vh; overflow-y: auto; box-shadow: 0 20px 40px rgba(0,0,0,.18); }
.dialog-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 14px; }
.dialog-head h3 { margin: 0; font-size: 16px; }
label { display: block; font-size: 12px; color: var(--text-muted); margin: 14px 0 6px; }
input, textarea, select { width: 100%; }
textarea { resize: vertical; line-height: 1.8; }
.outline-actions, .genre-row { display: flex; gap: 8px; align-items: center; margin-top: 8px; }
.genre-row select { flex: 1; }
.hint { font-size: 11px; color: var(--text-muted); line-height: 1.6; }
.dialog-actions { display: flex; gap: 8px; margin-top: 20px; align-items: center; }
.spacer { flex: 1; }
</style>
