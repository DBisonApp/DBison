<script setup lang="ts">
import { useModalContext } from '@kolirt/vue-modal'

/**
 * Help ▸ Support DBison: the one screen in the app that asks for something,
 * so it says plainly who is asking and what for before it offers a way to pay.
 *
 * The options are package.json's `support` field, read through
 * `shared/package-meta.js`:
 * - the Ko-fi and GitHub Sponsors pages, opened in the browser rather than as
 *   Ko-fi's embeddable widget, which would load Ko-fi's scripts into the
 *   app's own window;
 * - crypto addresses, shown one at a time behind currency tabs so a second or
 *   third coin costs no height: a QR code for a phone wallet, a copy button,
 *   and, where the coin has a standard payment link (Bitcoin's `bitcoin:`), a
 *   button that hands it to a wallet app on this computer.
 * An option that is not set up yet says "coming soon" rather than vanishing.
 */
const props = defineProps<{
  author: string
  github: string | null
  kofi: string | null
  crypto: { name: string, network: string, address: string, uri: string | null }[]
}>()

defineOptions({ modalGroup: 'dialog' })

const { close } = useModalContext()
const { notice, copy } = useClipboard()
const { announce } = useLiveAnnouncer()

const reasons = [
  { icon: 'sparkles', title: 'New features', detail: 'Shaped by the people using it' },
  { icon: 'bug', title: 'Faster fixes', detail: 'Time for the bugs you report' },
  { icon: 'shieldCheck', title: 'Stays private', detail: 'Paid for by people, not ads' },
] as const

// The main process hands an http(s) or bitcoin: window.open to the system:
// the browser for Ko-fi and GitHub, the registered wallet app for a payment link.
function openExternal(url: string) {
  window.open(url, '_blank', 'noopener')
}

/**
 * A few hearts float up from the buttons when someone heads to Ko-fi or GitHub
 * Sponsors: a thank you they see before they have paid anything. Each burst is its own set of
 * keys, so a second click starts fresh instead of restarting the first.
 */
const hearts = ref<{ key: number, x: number, drift: number, delay: number, size: number }[]>([])
/** Where the last click sent them, for the thank-you line; null before any. */
const thankedFor = ref<string | null>(null)
let burst = 0
let clearTimer: number | undefined

function openTip(url: string | null, site: string) {
  if (!url) return
  openExternal(url)

  thankedFor.value = site
  announce(`Thank you! ${site} is opening in your browser.`)

  burst += 1
  hearts.value = Array.from({ length: 9 }, (_, index) => ({
    key: burst * 100 + index,
    x: 18 + Math.random() * 64,
    drift: (Math.random() - 0.5) * 48,
    delay: Math.random() * 0.25,
    size: 12 + Math.round(Math.random() * 8),
  }))
  window.clearTimeout(clearTimer)
  clearTimer = window.setTimeout(() => { hearts.value = [] }, 1800)
}

onBeforeUnmount(() => window.clearTimeout(clearTimer))

/** The coin on show; the tabs switch it. */
const selectedIndex = ref(0)
const selected = computed(() => props.crypto[Math.min(selectedIndex.value, props.crypto.length - 1)] ?? null)

// Which address the last copy was of, so only that button says "Copied".
const copiedAddress = ref<string | null>(null)
watch(notice, (message) => {
  if (!message) copiedAddress.value = null
})

function copySelected() {
  if (!selected.value) return
  copiedAddress.value = selected.value.address
  copy(selected.value.address, `the ${selected.value.name} address`)
}

/** Arrow keys move along the tabs, as a tablist is expected to. */
function onTabKey(event: KeyboardEvent) {
  const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0
  if (!step) return
  event.preventDefault()
  selectedIndex.value = (selectedIndex.value + step + props.crypto.length) % props.crypto.length
  const tabs = (event.currentTarget as HTMLElement).querySelectorAll<HTMLButtonElement>('[role="tab"]')
  tabs[selectedIndex.value]?.focus()
}
</script>

<template>
  <AppDialog title="Support DBison" size="lg">
    <div class="grid">
      <header class="app-aurora app-grid-field flex flex-col items-center gap-2 overflow-hidden border-b border-edge px-6 pt-6 pb-5 text-center">
        <div class="relative">
          <AppLogo :size="48" class="drop-shadow-[0_6px_20px_var(--app-accent-line)]" />
          <span class="support-badge absolute -right-2 -bottom-0.5 flex size-6 items-center justify-center rounded-full" aria-hidden="true">
            <AppIcon name="heart" :size="12" :stroke-width="2.4" />
          </span>
        </div>

        <h2 class="font-display text-xl font-bold tracking-wide app-gradient-text">
          Keep DBison growing
        </h2>

        <p class="max-w-lg text-muted">
          Built by one person, {{ author }}. Open source, with no ads, no
          telemetry and no account. If DBison saves you time, a tip or a
          sponsorship keeps the work going.
        </p>
      </header>

      <div class="grid gap-4 p-5">
        <ul class="grid gap-3 sm:grid-cols-3">
          <li v-for="reason in reasons" :key="reason.title" class="flex items-center gap-2.5">
            <span class="flex size-8 shrink-0 items-center justify-center rounded-lg bg-accent-soft text-accent-bright">
              <AppIcon :name="reason.icon" :size="15" />
            </span>
            <span class="grid min-w-0">
              <span class="font-medium text-content">{{ reason.title }}</span>
              <span class="truncate text-xs text-faint" :title="reason.detail">{{ reason.detail }}</span>
            </span>
          </li>
        </ul>

        <div class="grid gap-4 md:grid-cols-2">
          <!-- Ko-fi and GitHub Sponsors: the main way in, so it carries the accent. -->
          <section class="support-card support-card-primary flex flex-col gap-3 rounded-xl p-4">
            <div class="flex items-center gap-2.5">
              <span class="flex size-9 shrink-0 items-center justify-center rounded-lg bg-accent-soft text-accent-bright">
                <AppIcon name="coffee" :size="18" />
              </span>
              <div class="grid">
                <h3 class="font-semibold text-content">
                  Tip or sponsor
                </h3>
                <p class="text-xs text-faint">
                  Ko-fi or GitHub Sponsors
                </p>
              </div>
            </div>

            <ul class="grid gap-1 text-muted">
              <li class="flex items-center gap-2">
                <AppIcon name="check" :size="13" :stroke-width="2.4" class="text-accent-bright" />
                Any amount you like
              </li>
              <li class="flex items-center gap-2">
                <AppIcon name="check" :size="13" :stroke-width="2.4" class="text-accent-bright" />
                Once, or monthly
              </li>
              <li class="flex items-center gap-2">
                <AppIcon name="check" :size="13" :stroke-width="2.4" class="text-accent-bright" />
                Done in about a minute
              </li>
            </ul>

            <div class="relative mt-auto grid gap-2">
              <button
                type="button"
                class="btn btn-accent w-full justify-center gap-2 px-4 py-2.5 text-[15px] font-semibold"
                :disabled="!kofi"
                @click="openTip(kofi, 'Ko-fi')"
              >
                <AppIcon name="heart" :size="15" :stroke-width="2.2" />
                {{ kofi ? 'Support on Ko-fi' : 'Coming soon' }}
              </button>
              <button
                v-if="github"
                type="button"
                class="btn w-full justify-center gap-2 px-4 py-2"
                @click="openTip(github, 'GitHub Sponsors')"
              >
                <AppIcon name="github" :size="15" />
                Sponsor on GitHub
              </button>

              <span
                v-for="heart in hearts"
                :key="heart.key"
                class="support-heart"
                :style="{ '--x': `${heart.x}%`, '--drift': `${heart.drift}px`, '--delay': `${heart.delay}s` }"
                aria-hidden="true"
              >
                <AppIcon name="heart" :size="heart.size" :stroke-width="2.4" />
              </span>
            </div>

            <p class="-mt-1 text-xs" :class="thankedFor ? 'text-accent-bright' : 'text-faint'" aria-live="polite">
              {{ thankedFor
                ? `Thank you! ${thankedFor} is opening in your browser.`
                : 'Opens in your browser. DBison never sees your payment details.' }}
            </p>
          </section>

          <!-- Crypto: one card, one coin at a time. -->
          <section v-if="selected" class="support-card flex flex-col gap-3 rounded-xl p-4">
            <div class="flex items-center justify-between gap-2">
              <div class="flex min-w-0 items-center gap-2.5">
                <span class="flex size-9 shrink-0 items-center justify-center rounded-lg bg-raised text-warning">
                  <AppIcon name="coins" :size="18" />
                </span>
                <div class="grid min-w-0">
                  <h3 class="truncate font-semibold text-content">
                    {{ crypto.length > 1 ? 'Crypto' : selected.name }}
                  </h3>
                  <!-- With tabs beside it there is no room for a long network
                       name here; the warning under the code names it instead,
                       so switching coins never changes the card's height. -->
                  <p v-if="crypto.length === 1" class="truncate text-xs text-faint">
                    {{ selected.network }} network
                  </p>
                </div>
              </div>

              <div
                v-if="crypto.length > 1"
                role="tablist"
                aria-label="Currency"
                class="flex shrink-0 rounded-lg bg-sunken p-0.5"
                @keydown="onTabKey"
              >
                <button
                  v-for="(entry, index) in crypto"
                  :key="`${entry.name}:${entry.network}`"
                  type="button"
                  role="tab"
                  :aria-selected="index === selectedIndex"
                  :tabindex="index === selectedIndex ? 0 : -1"
                  class="rounded-md px-2 py-1 text-xs font-medium transition-colors"
                  :class="index === selectedIndex ? 'bg-raised text-content shadow-sm' : 'text-faint hover:text-content'"
                  @click="selectedIndex = index"
                >
                  {{ entry.name }}
                </button>
              </div>
            </div>

            <div class="flex gap-3" role="tabpanel" :aria-label="`${selected.name} address`">
              <QrCode
                :key="selected.address"
                :value="selected.uri ?? selected.address"
                :size="124"
                :label="`QR code for the ${selected.name} address`"
                class="shrink-0 rounded-lg ring-1 ring-edge"
              />

              <div class="flex min-w-0 flex-1 flex-col justify-between gap-2">
                <code class="selectable rounded-md bg-sunken px-2 py-1.5 font-mono text-[11px] leading-snug break-all text-content">{{ selected.address }}</code>

                <div class="grid gap-1.5">
                  <button
                    type="button"
                    class="btn w-full justify-center gap-1.5 px-2.5 py-1.5 text-xs"
                    @click="copySelected"
                  >
                    <AppIcon :name="copiedAddress === selected.address ? 'check' : 'copy'" />
                    {{ copiedAddress === selected.address ? 'Copied' : 'Copy address' }}
                  </button>
                  <button
                    v-if="selected.uri"
                    type="button"
                    class="btn w-full justify-center gap-1.5 px-2.5 py-1.5 text-xs"
                    :title="`Opens a ${selected.name} wallet installed on this computer`"
                    @click="openExternal(selected.uri)"
                  >
                    <AppIcon name="wallet" />
                    Open in wallet
                  </button>
                </div>
              </div>
            </div>

            <p class="text-xs text-faint">
              Send only {{ selected.name }}, on the {{ selected.network }} network. Anything else is lost.
            </p>

            <span class="sr-only" role="status">{{ notice }}</span>
          </section>

          <section v-else class="support-card flex flex-col gap-2 rounded-xl p-4">
            <div class="flex items-center gap-2.5">
              <span class="flex size-9 shrink-0 items-center justify-center rounded-lg bg-raised text-faint">
                <AppIcon name="coins" :size="18" />
              </span>
              <h3 class="font-semibold text-content">
                Crypto
              </h3>
            </div>
            <p class="text-xs text-faint">
              Coming soon.
            </p>
          </section>
        </div>

        <footer class="flex flex-wrap items-center justify-between gap-3 border-t border-edge pt-4">
          <p class="flex items-center gap-2 text-muted">
            <AppIcon name="messageHeart" :size="15" class="shrink-0 text-accent-bright" />
            Can't tip? A star on GitHub or telling a colleague helps just as much.
          </p>
          <button type="button" class="btn px-3 py-1.5" autofocus @click="close()">
            Close
          </button>
        </footer>
      </div>
    </div>
  </AppDialog>
</template>

<style scoped>
.support-card {
  border: 1px solid var(--app-border);
  background: color-mix(in oklab, var(--app-surface) 80%, transparent);
}

/* The option most people will pick, lit the way the app lights its accent. */
.support-card-primary {
  border-color: var(--app-accent-line);
  background:
    linear-gradient(180deg, var(--app-accent-soft), transparent 55%),
    var(--app-surface);
  box-shadow: var(--app-glow);
}

.support-badge {
  background-image: var(--app-accent-gradient);
  color: var(--app-accent-text);
  box-shadow: var(--app-glow);
  animation: support-beat 2.8s ease-in-out infinite;
}

/* Two quick beats, then a rest, like a heart rather than a pulse. */
@keyframes support-beat {
  0%, 60%, 100% { transform: scale(1); }
  68% { transform: scale(1.2); }
  76% { transform: scale(0.95); }
  84% { transform: scale(1.12); }
}

.support-heart {
  position: absolute;
  bottom: 50%;
  left: var(--x);
  color: var(--app-accent-alt);
  opacity: 0;
  pointer-events: none;
  animation: support-float 1.3s ease-out var(--delay) forwards;
}

@keyframes support-float {
  0% { opacity: 0; transform: translate(-50%, 0) scale(0.6); }
  15% { opacity: 1; }
  100% { opacity: 0; transform: translate(calc(-50% + var(--drift)), -72px) scale(1.15); }
}

@media (prefers-reduced-motion: reduce) {
  .support-badge {
    animation: none;
  }

  .support-heart {
    display: none;
  }
}
</style>
