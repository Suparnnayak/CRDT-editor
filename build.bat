@echo off
em++ crdt_engine.cpp -o crdt_engine.js -O3 -lembind -s MODULARIZE=1 -s EXPORT_NAME="createCRDTModule"
