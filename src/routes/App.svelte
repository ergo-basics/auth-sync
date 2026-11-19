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
    import type { SyncRecord } from "$lib/core/types";

    const sync = new AuthSync(browserSigner, explorer_uri);

    let secret = "";
    let kind = "settings";
    let recId = "";
    let json = "{}";
    let encrypted = true;

    let publicRecords: SyncRecord[] = [];
    let secretRecords: SyncRecord[] | null = null;
    let hasEncrypted = false;
    let loaded = false;
    let busy = false;
    let error = "";
    let txId = "";

    async function run(fn: () => Promise<void>) {
        busy = true; error = ""; txId = "";
        try { await fn(); } catch (e: any) { error = e?.message ?? String(e); }
        busy = false;
    }

    const pull = () => run(async () => {
        const b = await sync.pull(secret || undefined);
        loaded = !!b;
        publicRecords = b?.publicRecords ?? [];
        secretRecords = b?.secretRecords ?? null;
        hasEncrypted = b?.hasEncrypted ?? false;
        if (!b) error = "No auth-sync box found for this address.";
    });

    function upsert(list: SyncRecord[] | null): SyncRecord[] {
        const rec: SyncRecord = { id: recId, kind, data: JSON.parse(json), updatedAt: Date.now() };
        return [...(list ?? []).filter(r => r.id !== rec.id), rec];
    }

    const push = () => run(async () => {
        if (!recId) throw new Error("Record id is required.");
        // Merge with the current state so unrelated records are kept.
        const cur = await sync.pull(secret || undefined);
        if (cur?.hasEncrypted && cur.secretRecords === null)
            throw new Error("The box has encrypted data: enter the secret first, or it would be lost.");
        let pub = cur?.publicRecords ?? [];
        let sec = cur?.secretRecords ?? [];
        if (encrypted) sec = upsert(sec); else pub = upsert(pub);
        const r = await sync.push({ publicRecords: pub, secretRecords: sec, secret: secret || undefined });
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
        Only the newest box counts. The secret never leaves this browser.
    </p>

    {#if !$walletConnected}
        <p>Connect a wallet to start.</p>
    {:else}
        <div class="space-y-2">
            <Label for="secret">Secret (passphrase)</Label>
            <Input id="secret" type="password" bind:value={secret} autocomplete="off" />
            <Button on:click={pull} disabled={busy}>Pull latest box</Button>
        </div>

        {#if loaded}
            <section class="space-y-2">
                <h2 class="font-medium">Public records</h2>
                {#each publicRecords as r}<pre class="text-xs p-2 border rounded overflow-x-auto">{r.id} [{r.kind}] {JSON.stringify(r.data)}</pre>{/each}
                <h2 class="font-medium">Encrypted records</h2>
                {#if secretRecords}
                    {#each secretRecords as r}<pre class="text-xs p-2 border rounded overflow-x-auto">{r.id} [{r.kind}] {JSON.stringify(r.data)}</pre>{/each}
                {:else if hasEncrypted}
                    <p class="text-sm">Locked. Enter the secret and pull again.</p>
                {:else}
                    <p class="text-sm">None.</p>
                {/if}
            </section>
        {/if}

        <section class="space-y-2">
            <h2 class="font-medium">Add / update a record</h2>
            <Label for="rid">Id</Label><Input id="rid" bind:value={recId} placeholder="chatui/settings" />
            <Label for="kind">Kind</Label><Input id="kind" bind:value={kind} placeholder="settings | mnemonic | app-config" />
            <Label for="json">Data (JSON)</Label><Textarea id="json" bind:value={json} rows={5} />
            <label class="flex items-center gap-2 text-sm"><input type="checkbox" bind:checked={encrypted} /> Encrypt</label>
            <Button on:click={push} disabled={busy}>Push new box</Button>
        </section>
    {/if}

    {#if error}<p class="text-sm text-red-500">{error}</p>{/if}
    {#if txId}<p class="text-sm">Submitted: <a class="underline" href={$web_explorer_uri_tx + txId} target="_blank" rel="noreferrer">{txId}</a></p>{/if}
</main>
