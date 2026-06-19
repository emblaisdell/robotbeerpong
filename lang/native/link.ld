/* Linker script for Robot Beer Pong native players (C and Rust).
 *
 * The simulated CPU (src/riscv.js) loads a *flat* binary at address 0, zeroes
 * all of RAM first, sets pc = 0 and sp = 0x0F000, then runs. There is no ELF
 * loader and no entry-point lookup: whatever sits at offset 0 of the image is
 * the first instruction executed. So `_start` must be physically first — we put
 * it in its own .text.start section and KEEP it at the top of .text.
 *
 * Layout (all below the stack at 0x0F000, MMIO begins at 0x10000):
 *   0x00000  .text  (starting with _start) + .rodata
 *            .data  (initialized globals — present in the flat image)
 *            .bss   (zeroed globals — NOT in the image; RAM is already zeroed)
 */
ENTRY(_start)

SECTIONS {
  . = 0x00000000;

  .text : {
    KEEP(*(.text.start))            /* _start, guaranteed at offset 0 */
    *(.text .text.*)
    *(.rodata .rodata.* .srodata .srodata.*)
  }

  .data : {
    *(.data .data.* .sdata .sdata.*)
  }

  .bss (NOLOAD) : {
    *(.bss .bss.* .sbss .sbss.* COMMON)
  }

  _stack_top = 0x0F000;             /* informational; the engine sets sp itself */

  /* Freestanding image: drop metadata the simulator neither needs nor decodes. */
  /DISCARD/ : {
    *(.eh_frame*)
    *(.comment)
    *(.riscv.attributes)
    *(.note*)
    *(.got*)
  }
}
