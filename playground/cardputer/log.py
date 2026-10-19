# the board's serial output for a few seconds, after a reset: python log.py PORT [SECONDS]
import sys, time, serial
port, seconds = sys.argv[1], float(sys.argv[2]) if len(sys.argv) > 2 else 5
s = serial.Serial(port, 115200, timeout=0.2)
s.dtr = False; s.rts = True; time.sleep(0.1); s.rts = False
end = time.time() + seconds
while time.time() < end:
    sys.stdout.write(s.read(4096).decode("utf-8", "replace")); sys.stdout.flush()
