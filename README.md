# Real-Time Collaborative CRDT Editor

A high-performance, real-time collaborative text editor built from scratch using a Sequence CRDT (Conflict-free Replicated Data Type). 

Unlike standard operational transformation (OT) editors that rely on a central server to resolve conflicts, this engine is fully peer-to-peer. The core algorithmic logic is written in **C++** for optimal memory management and execution speed, and compiled to **WebAssembly (WASM)** to run directly in the browser alongside a React frontend.

## 🚀 Tech Stack
* **Core Engine:** C++ (compiled to WebAssembly via Emscripten)
* **Frontend:** React.js, Tailwind CSS
* **Network Layer:** Node.js, Express, Socket.io
* **Database:** MongoDB (for document snapshot persistence)

## 🧠 How it Works (The DSA Focus)
This project implements a custom Sequence CRDT to handle concurrent editing without a master server:
1. **Fractional Indexing:** Instead of standard arrays, every character is assigned a mathematical fractional ID (represented as a `std::vector<int>` in C++) that sits strictly between adjacent characters.
2. **Lamport Clocks:** To break ties when two users type at the exact same millisecond, the engine uses logical Lamport timestamps and unique client IDs.
3. **Tombstones:** Deletions do not remove data from memory. Instead, characters are marked as "deleted" (tombstones) to maintain the mathematical structure of the document for delayed network edits.
4. **Custom C++ Bindings:** The `CRDT_Character` struct overloads the `<` operator to guarantee total ordering, utilizing `std::set` for $O(\log N)$ insertions and deterministic document convergence.

## 💻 Run it Locally

### Prerequisites
* Node.js
* MongoDB running locally
* Emscripten SDK (only if you wish to recompile the C++ engine)

### Setup
1. Clone the repo: `git clone <your-repo-url>`
2. Start the Server:
   ```bash
   cd server
   npm install
   node index.js