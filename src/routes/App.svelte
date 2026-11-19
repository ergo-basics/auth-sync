<script lang="ts">
    import Theme from "./Theme.svelte";
    import { Button } from "$lib/components/ui/button/index.js";
    import { Input } from "$lib/components/ui/input/index.js";
    import { Label } from "$lib/components/ui/label/index.js";
    import { Textarea } from "$lib/components/ui/textarea/index.js";
    import { web_explorer_uri_addr, web_explorer_uri_tx } from "$lib/common/store";
    import { WalletButton, walletConnected } from "wallet-svelte-component";
    import { AuthSync } from "$lib/core/authSync";
    import { browserSigner } from "$lib/ergo/browserSigner";
    import { explorer_uri } from "$lib/ergo/envs";
    import type { Merged } from "$lib/core/chain";

    const sync = new AuthSync(browserSigner, explorer_uri);

    let secret = "";
    let key = "";
    let json = "{}";
    let encrypted = true;

    let merged: Merged | null = null;
    let busy = false;
    let error = "";
    let txId = "";

    async function run(fn: () => Promise<void>) {
        busy = true; error = ""; txId = "";
        try { await fn(); } catch (e: any) { error = e?.message ?? String(e); }
        busy = false;
    }

    const pull = () => run(async () => { merged = await sync.pull(secret || undefined); });

    const push = (value?: unknown) => run(async () => {
        if (!key) throw new Error("Key is required.");
        const v = value === undefined ? JSON.parse(json) : value;
        // If a key moves between public and secret, the old copy must be shadowed.
        const r = await sync.push({
            publicEntries: encrypted ? {} : { [key]: v },
            secretEntries: encrypted ? { [key]: v } : {},
            secret: secret || undefined
        });
        txId = r.txId ?? "";
    });
</script>

<header class="flex items-center justify-between p-4 border-b">
    <h1 class="text-lg font-semibold">auth-sync</h1>
    <div class="flex items-center gap-2">
        <WalletButton explorerUrl={$web_explorer_uri_addr} />
        <Theme />
    </div>
</header>

<main class="max-w-2xl mx-auto p-4 space-y-6">
    <p class="text-sm text-muted-foreground">
        Keep encrypted settings and hot wallets in one Ergo box of your own address.
        Many boxes are merged; for each key the highest block wins. The secret never leaves this browser.
    </p>

    {#if !$walletConnected}
        <p>Connect a wallet to start.</p>
    {:else}
        <div class="space-y-2">
            <Label for="secret">Secret (passphrase)</Label>
            <Input id="secret" type="password" bind:value={secret} autocomplete="off" />
            <Button on:click={pull} disabled={busy}>Pull latest box</Button>
        </div>

        {#if merged}
            <section class="space-y-2">
                <h2 class="font-medium">Current state ({Object.keys(merged.entries).length} keys)</h2>
                {#each Object.entries(merged.entries) as [k, v]}
                    <pre class="text-xs p-2 border rounded overflow-x-auto">{k} = {JSON.stringify(v)}</pre>
                {/each}
                {#if merged.lockedBoxes.length}
                    <p class="text-sm">{merged.lockedBoxes.length} box(es) are locked. Enter the secret and pull again.</p>
                {/if}
            </section>
        {/if}

        <section class="space-y-2">
            <h2 class="font-medium">Set a key</h2>
            <Label for="key">Key</Label><Input id="key" bind:value={key} placeholder="chatui/settings" />
            <Label for="json">Data (JSON)</Label><Textarea id="json" bind:value={json} rows={5} />
            <label class="flex items-center gap-2 text-sm"><input type="checkbox" bind:checked={encrypted} /> Encrypt</label>
            <Button on:click={() => push()} disabled={busy}>Push</Button>
            <Button variant="outline" on:click={() => push(null)} disabled={busy}>Delete key</Button>
        </section>
    {/if}

    {#if error}<p class="text-sm text-red-500">{error}</p>{/if}
    {#if txId}<p class="text-sm">Submitted: <a class="underline" href={$web_explorer_uri_tx + txId} target="_blank" rel="noreferrer">{txId}</a></p>{/if}
</main>
