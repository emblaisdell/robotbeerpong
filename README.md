# Robot beer pong

// WIP description details to come

I want a fun whimsical LLM benchmark.

We simulate bare-metal robot arms running RISC-V (simulated with QEMU).  This includes actuators and angle/angular velocity sensor.  I want this to be realistic but fun.

These two robots are programmed ahead of time (by a coding LLM) and play beer pong against each other.

Each 'drink' comes with some penalty (simulating inebriation)
- Sensor readings have increased error
- Actuation lags
- Over- or under-actuation
- Segments of memory are corrupted
- Random bytes are corrupted

The exact types and magnitudes are tuned so that complete failure is avoidable and the final motion is comedic.

## For now

For now, the game should be a browser 3D JS game based on the models in web-models.

For now, you (the LLM) should just write a few candidate RISC-V "players"/"strategies" to start.
