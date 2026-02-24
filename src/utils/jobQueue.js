/**
 * Simple in-process async job queue (no Redis / BullMQ required).
 * Jobs are processed one at a time, in FIFO order, in the background.
 * Progress and results are stored in PostgreSQL (bulk_import_jobs table).
 */

class JobQueue {
    constructor(name) {
        this.name = name;
        this._queue = [];
        this._running = false;
    }

    /** Add a job. handler is an async () => void function. */
    enqueue(handler) {
        this._queue.push(handler);
        if (!this._running) this._tick();
    }

    async _tick() {
        if (this._queue.length === 0) {
            this._running = false;
            return;
        }

        this._running = true;
        const job = this._queue.shift();

        try {
            await job();
        } catch (err) {
            console.error(`[${this.name}] Unhandled job error:`, err.message);
        }

        // Yield to event loop so HTTP server stays responsive, then continue
        setImmediate(() => this._tick());
    }

    get size() { return this._queue.length; }
    get isRunning() { return this._running; }
}

// Singleton queue for bulk lead imports
export const leadImportQueue = new JobQueue('BulkLeads');
