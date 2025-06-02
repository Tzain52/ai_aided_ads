import urllib.request
import os

def download_get_pip():
    url = "https://bootstrap.pypa.io/get-pip.py"
    try:
        print("Downloading get-pip.py...")
        urllib.request.urlretrieve(url, "get-pip.py")
        print("Successfully downloaded get-pip.py")
    except Exception as e:
        print(f"Error downloading get-pip.py: {e}")

if __name__ == "__main__":
    download_get_pip()