# types lines into the board over its serial line and prints what comes back, without resetting
# it: python type.py PORT 'a = 3' 'b = 4' ...
import sys, time, serial
s = serial.Serial()
s.port, s.baudrate, s.timeout = sys.argv[1], 115200, 0.2
s.dtr, s.rts = False, False
s.open()
time.sleep(4)
s.read(65536)
for line in sys.argv[2:]:
    s.write((line + "\r").encode())
    time.sleep(0.6)
    sys.stdout.write(s.read(65536).decode("utf-8", "replace"))
